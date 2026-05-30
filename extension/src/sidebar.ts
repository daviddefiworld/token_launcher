import { io, Socket } from 'socket.io-client';
import { RUNTIME_MSG, TOKEN_AUTOMATION_PORT } from './types';
import type { AutomationProgressMessage, AutomationResultMessage } from './types';

const DEFAULT_BACKEND_URL = 'http://localhost:5050';
const BITUNIX_WITHDRAW_URL = 'https://www.bitunix.com/assets/withdraw';
const BITUNIX_WALLET_URL = 'https://www.bitunix.com/assets/overview';
const POST_SUCCESS_WALLET_DELAY_MS = 120_000;
const POST_ORDER_SETTLE_MS = 4_000;
const ORDER_TIMEOUT_MS = 20 * 60 * 1000;
const SLOW_PAGE_TIMEOUT_MS = 60000;
const EMAIL_CODE_WAIT_TIMEOUT_MS = 190000;
const WITHDRAW_ORDER_MAX_ATTEMPTS = 3;
const WITHDRAW_RETRY_DELAY_MS = 5000;
const WITHDRAW_PROGRESS_TIMEOUT_MS = 2 * 60 * 1000;
const STORAGE_KEYS = {
  backendUrl: 'tokenAutomationBackendUrl',
  extensionId: 'tokenAutomationExtensionId'
} as const;

interface RunOrderPayload {
  orderId: string;
  text?: string;
  currency?: string;
  chain?: string;
  address?: string;
  amount?: string;
  emailCode?: string;
  authenticatorCode?: string;
}

interface ContentOrderResponse {
  success?: boolean;
  message?: string;
  pageUrl?: string;
  pageTitle?: string;
  completedAt?: string;
  error?: string;
  verificationRequired?: boolean;
  emailCodeSent?: boolean;
  emailCodeSentAt?: number;
  emailCode?: string;
}

interface ContentPingResponse {
  success?: boolean;
}

let socket: Socket | null = null;
let extensionId = '';
let runningOrderId: string | null = null;
let lastBitunixTabId: number | undefined;
const orderQueue: RunOrderPayload[] = [];
const cancelledOrderIds = new Set<string>();
let drainingOrderQueue = false;
let postOrderWalletTimer: number | undefined;

const ORDER_CANCELLED_MESSAGE = 'Order cancelled';
const CONTENT_TRANSPORT_RETRIES = 2;

type ContentMessageType = 'tokenAutomationOrder' | 'tokenAutomationCompleteVerification' | 'tokenAutomationPrepare';

const backendInput = document.getElementById('backend-url') as HTMLInputElement;
const saveButton = document.getElementById('save-backend') as HTMLButtonElement;
const statusEl = document.getElementById('connection-status') as HTMLElement;
const extensionIdEl = document.getElementById('extension-id') as HTMLElement;
const lastOrderEl = document.getElementById('last-order') as HTMLElement;
const messageEl = document.getElementById('message') as HTMLElement;
const verificationPanelEl = document.getElementById('verification-panel') as HTMLElement;
const verificationEmailCodeEl = document.getElementById('verification-email-code') as HTMLElement;
const verificationAuthCodeEl = document.getElementById('verification-auth-code') as HTMLElement;

function setMessage(message: string): void {
  messageEl.textContent = message;
}

function setStatus(status: string): void {
  statusEl.textContent = status;
}

function storageGet(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

function getActiveTab(): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        reject(new Error('No active tab found'));
        return;
      }
      resolve(tab);
    });
  });
}

function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function updateTab(tabId: number, properties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, properties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!tab) {
        reject(new Error('Tab update did not return a tab'));
        return;
      }
      resolve(tab);
    });
  });
}

function queryTabs(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => chrome.tabs.query(query, resolve));
}

async function findBitunixTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await queryTabs({ url: ['*://www.bitunix.com/*'] });
  return (
    tabs.find((tab) => isBitunixWithdrawUrl(tab.url)) ||
    tabs.find((tab) => tab.url?.includes('/assets/')) ||
    tabs[0] ||
    null
  );
}

async function resolveWithdrawTab(): Promise<chrome.tabs.Tab> {
  if (lastBitunixTabId !== undefined) {
    try {
      const tab = await getTab(lastBitunixTabId);
      if (tab.id && tab.url && /bitunix\.com/i.test(tab.url)) {
        return tab;
      }
    } catch {
      lastBitunixTabId = undefined;
    }
  }

  const bitunixTab = await findBitunixTab();
  if (bitunixTab?.id) {
    return bitunixTab;
  }

  return getActiveTab();
}

async function waitForWithdrawPageReady(tabId: number, timeoutMs = SLOW_PAGE_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const tab = await getTab(tabId);
      if (isBitunixWithdrawUrl(tab.url)) {
        if (await pingContent(tabId)) {
          return;
        }
        await injectContent(tabId);
        if (await pingContent(tabId)) {
          return;
        }
      }
    } catch {
      // Tab may still be loading.
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for the withdraw page');
}

function waitForTabComplete(tabId: number, timeoutMs = SLOW_PAGE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for the page to load'));
    }, timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab.status === 'complete') {
        finish();
      }
    });
  });
}

function assertInjectableTab(tab: chrome.tabs.Tab): void {
  const url = tab.url || '';
  if (/^(https?|file):\/\//.test(url)) {
    return;
  }

  throw new Error('Open a regular web page before running an order.');
}

function pingContent(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'tokenAutomationPing' },
      (response: ContentPingResponse | undefined) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(response?.success === true);
      }
    );
  });
}

function injectContent(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function ensureContentScript(tab: chrome.tabs.Tab): Promise<number> {
  if (!tab.id) {
    throw new Error('No active tab found');
  }

  assertInjectableTab(tab);

  if (await pingContent(tab.id)) {
    return tab.id;
  }

  await injectContent(tab.id);
  return tab.id;
}

function isBitunixWithdrawUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'www.bitunix.com' && parsed.pathname.startsWith('/assets/withdraw');
  } catch {
    return false;
  }
}

function formatMessagingError(message: string | undefined): string {
  if (!message) {
    return 'Content script disconnected before the withdraw finished';
  }
  if (/message (?:port|channel) closed before a response was received/i.test(message)) {
    return 'Bitunix withdraw page reloaded or navigated while automation was running';
  }
  if (/Could not establish connection/i.test(message)) {
    return 'Content script is not loaded on the Bitunix tab. Open bitunix.com and reload the extension.';
  }
  return message;
}

function cancelPostOrderWalletNavigation(): void {
  if (postOrderWalletTimer !== undefined) {
    window.clearTimeout(postOrderWalletTimer);
    postOrderWalletTimer = undefined;
  }
}

async function reloadWithdrawPage(tabId: number): Promise<void> {
  setMessage('Refreshing Bitunix withdraw page...');
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      window.location.reload();
    }
  });
  await waitForTabComplete(tabId);
  await waitForWithdrawPageReady(tabId);
}

async function ensureWithdrawTab(tab: chrome.tabs.Tab, options?: { reload?: boolean }): Promise<chrome.tabs.Tab> {
  if (!tab.id) {
    throw new Error('No active tab found');
  }

  const current = await getTab(tab.id);
  if (isBitunixWithdrawUrl(current.url)) {
    if (options?.reload) {
      await reloadWithdrawPage(tab.id);
    } else {
      await waitForWithdrawPageReady(tab.id);
    }
    lastBitunixTabId = tab.id;
    return getTab(tab.id);
  }

  setMessage('Opening Bitunix withdraw page...');
  await updateTab(tab.id, { url: BITUNIX_WITHDRAW_URL, active: true });
  await waitForWithdrawPageReady(tab.id);
  lastBitunixTabId = tab.id;
  return getTab(tab.id);
}

function sendQuickContentCommand(
  tabId: number,
  type: 'tokenAutomationPrepare',
  payload: Partial<RunOrderPayload> = {}
): Promise<ContentOrderResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port: chrome.runtime.Port | null = null;

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      handler();
    };

    const timeoutId = window.setTimeout(() => {
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
      finish(() => reject(new Error('Timed out preparing withdraw page')));
    }, SLOW_PAGE_TIMEOUT_MS);

    try {
      port = chrome.tabs.connect(tabId, { name: TOKEN_AUTOMATION_PORT });
    } catch (error) {
      finish(() =>
        reject(new Error(formatMessagingError(error instanceof Error ? error.message : 'Could not connect to page')))
      );
      return;
    }

    port.onMessage.addListener((message: { ok?: boolean; response?: ContentOrderResponse }) => {
      const response = message.response;
      finish(() => {
        try {
          port?.disconnect();
        } catch {
          // ignore
        }
        if (!message.ok || !response?.success) {
          reject(new Error(response?.error || 'Content script did not prepare the page'));
          return;
        }
        resolve(response);
      });
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      finish(() => reject(new Error(formatMessagingError(chrome.runtime.lastError?.message))));
    });

    port.postMessage({
      ...payload,
      type,
      text: payload.text || 'Bitunix withdraw'
    });
  });
}

function waitForContentResult(orderId: string, onProgress?: (message: string) => void): Promise<ContentOrderResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = 0;
    let lastProgressAt = Date.now();
    let watchdogId = 0;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      window.clearInterval(watchdogId);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    };

    const resetTimeout = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for Bitunix automation in the page'));
      }, WITHDRAW_PROGRESS_TIMEOUT_MS);
    };

    const onRuntimeMessage = (message: AutomationProgressMessage | AutomationResultMessage) => {
      if (!message?.type || message.orderId !== orderId) return;

      if (message.type === RUNTIME_MSG.progress) {
        lastProgressAt = Date.now();
        resetTimeout();
        if (message.message) onProgress?.(message.message);
        return;
      }

      if (message.type === RUNTIME_MSG.result) {
        cleanup();
        if (message.ok && message.response?.success) {
          resolve(message.response);
          return;
        }
        reject(new Error(message.response?.error || 'Content script did not complete the order'));
      }
    };

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    resetTimeout();

    watchdogId = window.setInterval(() => {
      if (settled) return;
      if (Date.now() - lastProgressAt > ORDER_TIMEOUT_MS) {
        cleanup();
        reject(new Error('Timed out waiting for Bitunix automation in the page'));
      }
    }, 30_000);
  });
}

function sendLongRunningContentCommand(
  tabId: number,
  type: Exclude<ContentMessageType, 'tokenAutomationPrepare'>,
  payload: Partial<RunOrderPayload> = {}
): Promise<ContentOrderResponse> {
  const orderId = payload.orderId?.trim();
  if (!orderId) {
    return Promise.reject(new Error('orderId is required'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let port: chrome.runtime.Port | null = null;
    let accepted = false;

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(connectTimeoutId);
      handler();
    };

    const connectTimeoutId = window.setTimeout(() => {
      if (accepted) return;
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
      finish(() => reject(new Error('Timed out connecting to Bitunix page for withdraw')));
    }, SLOW_PAGE_TIMEOUT_MS);

    try {
      port = chrome.tabs.connect(tabId, { name: TOKEN_AUTOMATION_PORT });
    } catch (error) {
      finish(() =>
        reject(new Error(formatMessagingError(error instanceof Error ? error.message : 'Could not connect to page')))
      );
      return;
    }

    port.onMessage.addListener((message: { ok?: boolean; accepted?: boolean; orderId?: string }) => {
      if (!message.accepted || message.orderId !== orderId) return;
      accepted = true;
      window.clearTimeout(connectTimeoutId);
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
      void waitForContentResult(orderId, (progress) => setMessage(progress)).then(
        (response) => finish(() => resolve(response)),
        (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      );
    });

    port.onDisconnect.addListener(() => {
      if (settled || accepted) return;
      finish(() => reject(new Error(formatMessagingError(chrome.runtime.lastError?.message))));
    });

    port.postMessage({
      ...payload,
      type,
      text: payload.text || 'Bitunix withdraw'
    });
  });
}

async function ensureTabOnWithdrawPage(tabId: number): Promise<void> {
  const tab = await getTab(tabId);
  if (isBitunixWithdrawUrl(tab.url)) {
    await waitForWithdrawPageReady(tabId);
    return;
  }
  setMessage('Opening Bitunix withdraw page...');
  await updateTab(tabId, { url: BITUNIX_WITHDRAW_URL, active: true });
  await waitForWithdrawPageReady(tabId);
}

async function prepareWithdrawPage(tabId: number): Promise<void> {
  await ensureTabOnWithdrawPage(tabId);
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= CONTENT_TRANSPORT_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await ensureTabOnWithdrawPage(tabId);
      await delay(1500);
    }
    try {
      await sendQuickContentCommand(tabId, 'tokenAutomationPrepare');
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableMessagingError(lastError.message) || attempt >= CONTENT_TRANSPORT_RETRIES) {
        throw lastError;
      }
    }
  }
  throw lastError || new Error('Content script did not prepare the page');
}

function isRetryableMessagingError(message: string): boolean {
  return (
    /message (?:port|channel) closed|disconnected before|Could not establish connection|Timed out waiting for Bitunix automation|Timed out connecting to Bitunix page|Timed out preparing withdraw page/i.test(
      message
    )
  );
}

async function sendToContent(
  tabId: number,
  type: Exclude<ContentMessageType, 'tokenAutomationPrepare'>,
  payload: Partial<RunOrderPayload> = {}
): Promise<ContentOrderResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= CONTENT_TRANSPORT_RETRIES; attempt += 1) {
    if (attempt > 0) {
      setMessage(`Reconnecting to Bitunix page (${attempt + 1}/${CONTENT_TRANSPORT_RETRIES + 1})...`);
      await ensureContentScript(await getTab(tabId));
      await reloadWithdrawPage(tabId);
      await delay(1500);
    }

    try {
      return await sendLongRunningContentCommand(tabId, type, payload);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableMessagingError(lastError.message) || attempt >= CONTENT_TRANSPORT_RETRIES) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('Content script did not complete the order');
}

function showVerificationCodes(emailCode: string, authenticatorCode: string): void {
  verificationEmailCodeEl.textContent = emailCode;
  verificationAuthCodeEl.textContent = authenticatorCode;
  verificationPanelEl.hidden = false;
}

function hideVerificationCodes(): void {
  verificationPanelEl.hidden = true;
  verificationEmailCodeEl.textContent = '—';
  verificationAuthCodeEl.textContent = '—';
}

function requestVerificationCodeFromBackend(orderId: string, emailCodeSentAt: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('Extension is not connected to the backend'));
      return;
    }

    if (isOrderCancelled(orderId)) {
      reject(new Error(ORDER_CANCELLED_MESSAGE));
      return;
    }

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Bitunix verification email from backend'));
    }, EMAIL_CODE_WAIT_TIMEOUT_MS);

    const onReady = (data: { orderId?: string; emailCode?: string }) => {
      if (data.orderId !== orderId || !data.emailCode?.trim()) return;
      cleanup();
      if (isOrderCancelled(orderId)) {
        reject(new Error(ORDER_CANCELLED_MESSAGE));
        return;
      }
      resolve(data.emailCode.trim());
    };

    const onFailed = (data: { orderId?: string; error?: string }) => {
      if (data.orderId !== orderId) return;
      cleanup();
      reject(new Error(data.error || 'Backend could not find verification email'));
    };

    const onCancel = (data: { orderId?: string }) => {
      if (data.orderId !== orderId) return;
      cleanup();
      reject(new Error(ORDER_CANCELLED_MESSAGE));
    };

    function cleanup(): void {
      window.clearTimeout(timeoutId);
      socket?.off('extension:verification_code_ready', onReady);
      socket?.off('extension:verification_code_failed', onFailed);
      socket?.off('extension:cancel_order', onCancel);
    }

    socket.on('extension:verification_code_ready', onReady);
    socket.on('extension:verification_code_failed', onFailed);
    socket.on('extension:cancel_order', onCancel);

    socket.emit(
      'extension:request_verification_code',
      { orderId, emailCodeSentAt },
      (ack?: { success?: boolean; error?: string }) => {
        if (!ack?.success) {
          cleanup();
          reject(new Error(ack?.error || 'Backend rejected verification code request'));
        }
      }
    );
  });
}

async function resolveEmailCode(orderId: string, emailCodeSentAt: number, providedCode?: string): Promise<string> {
  const trimmed = providedCode?.trim();
  if (trimmed && trimmed !== '000000') return trimmed;

  setMessage('Requesting verification code from Gmail (backend)...');
  return requestVerificationCodeFromBackend(orderId, emailCodeSentAt);
}

function requestAuthenticatorCodeFromBackend(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('Extension is not connected to the backend'));
      return;
    }

    socket.emit(
      'extension:request_authenticator_code',
      (ack?: { success?: boolean; authenticatorCode?: string; error?: string }) => {
        const code = ack?.authenticatorCode?.trim();
        if (ack?.success && code) {
          resolve(code);
          return;
        }
        reject(new Error(ack?.error || 'Backend could not generate authenticator code'));
      }
    );
  });
}

async function readAuthenticatorCode(providedCode?: string): Promise<string> {
  const trimmed = providedCode?.trim();
  if (trimmed) return trimmed;
  return requestAuthenticatorCodeFromBackend();
}

async function currentTabUrl(): Promise<string | undefined> {
  try {
    const tab = await getActiveTab();
    return tab.url;
  } catch {
    return undefined;
  }
}

async function reportStatus(): Promise<void> {
  const currentUrl = await currentTabUrl();
  socket?.emit('extension:status_update', { currentUrl });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isOrderCancelled(orderId: string): boolean {
  return cancelledOrderIds.has(orderId);
}

function assertOrderActive(orderId: string): void {
  if (isOrderCancelled(orderId)) {
    throw new Error(ORDER_CANCELLED_MESSAGE);
  }
}

function cancelLocalOrder(orderId: string): void {
  cancelledOrderIds.add(orderId);
  for (let index = orderQueue.length - 1; index >= 0; index -= 1) {
    if (orderQueue[index]?.orderId === orderId) {
      orderQueue.splice(index, 1);
    }
  }
  if (runningOrderId === orderId) {
    setMessage(`Order ${orderId.slice(0, 8)} stopping…`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function executeWithdrawOrder(
  payload: RunOrderPayload,
  setBitunixTabId: (tabId: number) => void
): Promise<ContentOrderResponse> {
  assertOrderActive(payload.orderId);
  setMessage(`Starting order ${payload.orderId.slice(0, 8)}…`);
  const tab = await resolveWithdrawTab();
  assertOrderActive(payload.orderId);
  const withdrawTab = await ensureWithdrawTab(tab);
  assertOrderActive(payload.orderId);
  const tabId = await ensureContentScript(withdrawTab);
  lastBitunixTabId = tabId;
  setBitunixTabId(tabId);
  let result = await sendToContent(tabId, 'tokenAutomationOrder', payload);

  if (result.verificationRequired) {
    assertOrderActive(payload.orderId);
    const emailCodeSentAt = result.emailCodeSentAt || Date.now();
    const emailCode = await resolveEmailCode(payload.orderId, emailCodeSentAt, payload.emailCode || result.emailCode);
    assertOrderActive(payload.orderId);
    const authenticatorCode = await readAuthenticatorCode(payload.authenticatorCode);

    showVerificationCodes(emailCode, authenticatorCode);
    setMessage('Codes received. Filling Bitunix verification modal...');

    await updateTab(tabId, { active: true });
    await waitForTabComplete(tabId).catch(() => undefined);
    assertOrderActive(payload.orderId);
    await ensureContentScript(await getTab(tabId));

    result = await sendToContent(tabId, 'tokenAutomationCompleteVerification', {
      ...payload,
      emailCode,
      authenticatorCode
    });
  }

  assertOrderActive(payload.orderId);
  return result;
}

async function moveToBitunixWallet(tabId?: number, statusMessage = 'Opening Bitunix wallet...'): Promise<void> {
  try {
    const tab = tabId !== undefined ? await getTab(tabId) : await getActiveTab();
    if (!tab.id) return;
    setMessage(statusMessage);
    await updateTab(tab.id, { url: BITUNIX_WALLET_URL, active: true });
    await waitForTabComplete(tab.id).catch(() => undefined);
    await reportStatus();
  } catch {
    // Best-effort navigation after the order finishes.
  }
}

async function runOrder(payload: RunOrderPayload): Promise<void> {
  if (isOrderCancelled(payload.orderId)) {
    return;
  }

  lastOrderEl.textContent = payload.orderId.slice(0, 8);
  hideVerificationCodes();
  setMessage('Running Bitunix withdraw order...');

  let bitunixTabId: number | undefined;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= WITHDRAW_ORDER_MAX_ATTEMPTS; attempt += 1) {
    if (isOrderCancelled(payload.orderId)) {
      setMessage('Withdraw cancelled.');
      return;
    }

    if (attempt > 1) {
      setMessage(`Retrying withdraw (${attempt}/${WITHDRAW_ORDER_MAX_ATTEMPTS})...`);
      await delay(WITHDRAW_RETRY_DELAY_MS);
      if (bitunixTabId !== undefined) {
        await ensureTabOnWithdrawPage(bitunixTabId).catch(() => undefined);
        await reloadWithdrawPage(bitunixTabId).catch(() => undefined);
      }
    }

    try {
      const result = await withTimeout(
        executeWithdrawOrder(payload, (tabId) => {
          bitunixTabId = tabId;
        }),
        ORDER_TIMEOUT_MS,
        `Order timed out after ${Math.round(ORDER_TIMEOUT_MS / 60000)} minutes`
      );

      if (isOrderCancelled(payload.orderId)) {
        setMessage('Withdraw cancelled.');
        return;
      }

      if (bitunixTabId !== undefined) {
        setMessage('Settling withdraw page...');
        await delay(POST_ORDER_SETTLE_MS);
        await prepareWithdrawPage(bitunixTabId).catch(() => undefined);
      }

      socket?.emit('extension:order_result', {
        orderId: payload.orderId,
        status: 'completed',
        output: result
      });

      setMessage('Withdraw complete.');
      cancelPostOrderWalletNavigation();
      if (orderQueue.length === 0) {
        postOrderWalletTimer = window.setTimeout(() => {
          postOrderWalletTimer = undefined;
          if (orderQueue.length > 0 || runningOrderId !== null) return;
          void moveToBitunixWallet(bitunixTabId, 'Opening Bitunix wallet...');
        }, POST_SUCCESS_WALLET_DELAY_MS);
      }
      return;
    } catch (error) {
      if (isOrderCancelled(payload.orderId) || (error instanceof Error && error.message === ORDER_CANCELLED_MESSAGE)) {
        setMessage('Withdraw cancelled.');
        return;
      }

      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= WITHDRAW_ORDER_MAX_ATTEMPTS) {
        break;
      }
    }
  }

  const message = lastError?.message || 'Order failed';
  setMessage(message);
  socket?.emit('extension:order_result', {
    orderId: payload.orderId,
    status: 'failed',
    error: message
  });
  void moveToBitunixWallet(bitunixTabId, 'Withdraw failed. Opening Bitunix wallet...');
}

async function drainOrderQueue(): Promise<void> {
  if (drainingOrderQueue) return;
  drainingOrderQueue = true;
  try {
    while (orderQueue.length > 0) {
      const payload = orderQueue.shift()!;
      if (isOrderCancelled(payload.orderId)) {
        continue;
      }
      runningOrderId = payload.orderId;
      try {
        await runOrder(payload);
      } finally {
        if (runningOrderId === payload.orderId) runningOrderId = null;
      }
    }
  } finally {
    drainingOrderQueue = false;
    if (orderQueue.length > 0) {
      void drainOrderQueue();
    }
  }
}

function enqueueOrder(payload: RunOrderPayload): void {
  if (isOrderCancelled(payload.orderId)) {
    return;
  }
  cancelPostOrderWalletNavigation();
  orderQueue.push(payload);
  if (runningOrderId) {
    setMessage(`Order ${payload.orderId.slice(0, 8)} queued (${orderQueue.length} waiting)…`);
  }
  void drainOrderQueue();
}

async function connect(): Promise<void> {
  socket?.disconnect();
  const stored = await storageGet([STORAGE_KEYS.backendUrl, STORAGE_KEYS.extensionId]);
  const backendUrl =
    typeof stored[STORAGE_KEYS.backendUrl] === 'string'
      ? (stored[STORAGE_KEYS.backendUrl] as string)
      : DEFAULT_BACKEND_URL;
  extensionId =
    typeof stored[STORAGE_KEYS.extensionId] === 'string'
      ? (stored[STORAGE_KEYS.extensionId] as string)
      : '';

  backendInput.value = backendUrl;
  extensionIdEl.textContent = extensionId || 'pending registration';
  setStatus('Connecting...');

  socket = io(backendUrl, {
    transports: ['websocket', 'polling'],
    reconnection: true
  });

  socket.on('connect', async () => {
    setStatus('Connected');
    socket?.emit('extension:connect', {
      extensionId: extensionId || undefined,
      currentUrl: await currentTabUrl(),
      userAgent: navigator.userAgent,
      version: chrome.runtime.getManifest().version
    });
  });

  socket.on('disconnect', () => {
    setStatus('Disconnected');
  });

  socket.on('connect_error', (error: Error) => {
    setStatus('Error');
    setMessage(error.message);
  });

  socket.on('extension:connected', async (data: { extensionId?: string }) => {
    if (!data.extensionId) return;
    extensionId = data.extensionId;
    extensionIdEl.textContent = extensionId;
    await storageSet({ [STORAGE_KEYS.extensionId]: extensionId });
    setMessage('Connected. Waiting for orders...');
  });

  socket.on('extension:run_order', (payload: RunOrderPayload) => {
    enqueueOrder(payload);
  });

  socket.on('extension:cancel_order', (data: { orderId?: string }) => {
    const orderId = data.orderId?.trim();
    if (!orderId) return;
    cancelLocalOrder(orderId);
    setMessage(`Order ${orderId.slice(0, 8)} cancelled.`);
  });
}

saveButton.addEventListener('click', () => {
  void (async () => {
    const backendUrl = backendInput.value.trim() || DEFAULT_BACKEND_URL;
    await storageSet({ [STORAGE_KEYS.backendUrl]: backendUrl });
    setMessage('Saved. Reconnecting...');
    await connect();
  })();
});

chrome.tabs.onActivated.addListener(() => {
  void reportStatus();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    void reportStatus();
  }
});

void connect();
