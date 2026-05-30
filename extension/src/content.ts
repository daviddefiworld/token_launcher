import type { AutomationResponse, TokenAutomationMessage } from './types';
import { RUNTIME_MSG, TOKEN_AUTOMATION_PORT } from './types';
import { prepareForNextWithdraw, runWithdraw, submitVerification } from './skills/bitunix';
import { writeStatus } from './skills/dom';

const PROGRESS_INTERVAL_MS = 12_000;
const LONG_RUNNING_TYPES = new Set(['tokenAutomationOrder', 'tokenAutomationCompleteVerification']);

const globalWindow = window as typeof window & {
  __tokenAutomationContentLoaded?: boolean;
};

function postRuntimeResult(orderId: string, ok: boolean, response: AutomationResponse): void {
  void chrome.runtime
    .sendMessage({
      type: RUNTIME_MSG.result,
      orderId,
      ok,
      response
    })
    .catch(() => undefined);
}

async function handleAutomationMessage(message: TokenAutomationMessage): Promise<AutomationResponse> {
  if (message.type === 'tokenAutomationPrepare') {
    await prepareForNextWithdraw();
    return {
      success: true,
      message: 'Withdraw page ready for next order',
      pageUrl: window.location.href,
      pageTitle: document.title,
      completedAt: new Date().toISOString()
    };
  }
  if (message.type === 'tokenAutomationOrder') {
    await prepareForNextWithdraw().catch(() => undefined);
    return runWithdraw(message);
  }
  if (message.type === 'tokenAutomationCompleteVerification') {
    return submitVerification(message);
  }
  throw new Error(`Unsupported automation message type: ${message.type || 'unknown'}`);
}

async function runLongJob(message: TokenAutomationMessage): Promise<void> {
  const orderId = message.orderId?.trim();
  if (!orderId) {
    postRuntimeResult('unknown', false, {
      success: false,
      error: 'orderId is required for withdraw automation',
      completedAt: new Date().toISOString()
    });
    return;
  }

  const keepalive = window.setInterval(() => {
    const statusText = document.getElementById('token-automation-order-done')?.textContent?.trim();
    void chrome.runtime
      .sendMessage({
        type: RUNTIME_MSG.progress,
        orderId,
        message: statusText || 'Running Bitunix withdraw automation...'
      })
      .catch(() => undefined);
  }, PROGRESS_INTERVAL_MS);

  try {
    const response = await handleAutomationMessage(message);
    postRuntimeResult(orderId, true, response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Automation failed';
    writeStatus(errorMessage);
    postRuntimeResult(orderId, false, {
      success: false,
      error: errorMessage,
      pageUrl: window.location.href,
      pageTitle: document.title,
      completedAt: new Date().toISOString()
    });
  } finally {
    window.clearInterval(keepalive);
  }
}

function setupPortHandler(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== TOKEN_AUTOMATION_PORT) return;

    port.onMessage.addListener((message: TokenAutomationMessage) => {
      if (LONG_RUNNING_TYPES.has(message.type || '')) {
        try {
          port.postMessage({ ok: true, accepted: true, orderId: message.orderId });
        } catch {
          // Port may already be gone; job still runs and reports via runtime.sendMessage.
        }
        void runLongJob(message);
        return;
      }

      void (async () => {
        try {
          const response = await handleAutomationMessage(message);
          port.postMessage({ ok: true, response });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Automation failed';
          writeStatus(errorMessage);
          port.postMessage({
            ok: false,
            response: {
              success: false,
              error: errorMessage,
              pageUrl: window.location.href,
              pageTitle: document.title,
              completedAt: new Date().toISOString()
            } satisfies AutomationResponse
          });
        }
      })();
    });
  });
}

function setupMessageHandler(): void {
  chrome.runtime.onMessage.addListener((message: TokenAutomationMessage, _sender, sendResponse) => {
    if (message.type !== 'tokenAutomationPing') {
      return false;
    }
    sendResponse({ success: true });
    return false;
  });
}

if (!globalWindow.__tokenAutomationContentLoaded) {
  globalWindow.__tokenAutomationContentLoaded = true;
  setupPortHandler();
  setupMessageHandler();
}
