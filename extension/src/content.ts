import type { AutomationResponse, TokenAutomationMessage } from './types';
import { runWithdraw, submitVerification } from './skills/bitunix';
import { writeStatus } from './skills/shared/status';

const globalWindow = window as typeof window & {
  __tokenAutomationContentLoaded?: boolean;
};

if (!globalWindow.__tokenAutomationContentLoaded) {
  globalWindow.__tokenAutomationContentLoaded = true;

  chrome.runtime.onMessage.addListener(
    (message: TokenAutomationMessage, _sender, sendResponse: (response: unknown) => void) => {
      if (message.type === 'tokenAutomationPing') {
        sendResponse({ success: true });
        return false;
      }

      if (!['tokenAutomationOrder', 'tokenAutomationCompleteVerification'].includes(message.type || '')) {
        return false;
      }

      void (async () => {
        try {
          const response: AutomationResponse =
            message.type === 'tokenAutomationOrder' ? await runWithdraw(message) : await submitVerification(message);
          sendResponse(response);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Automation failed';
          writeStatus(errorMessage);
          sendResponse({
            success: false,
            error: errorMessage,
            pageUrl: window.location.href,
            pageTitle: document.title,
            completedAt: new Date().toISOString()
          });
        }
      })();
      return true;
    }
  );
}
