import { io, Socket } from 'socket.io-client';

const DEFAULT_BACKEND_URL = 'http://localhost:5050';
const BITUNIX_WITHDRAW_URL = 'https://www.bitunix.com/assets/withdraw';
const BITUNIX_WALLET_URL = 'https://www.bitunix.com/assets/overview';
const POST_SUCCESS_WALLET_DELAY_MS = 30_000;
const ORDER_TIMEOUT_MS = 5 * 60 * 1000;
const SLOW_PAGE_TIMEOUT_MS = 120000;
const EMAIL_CODE_WAIT_TIMEOUT_MS = 190000;
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

async function ensureWithdrawTab(tab: chrome.tabs.Tab): Promise<chrome.tabs.Tab> {
  if (!tab.id) {
    throw new Error('No active tab found');
  }

  if (isBitunixWithdrawUrl(tab.url)) {
    return tab;
  }

  setMessage('Opening Bitunix withdraw page...');
  const updated = await updateTab(tab.id, { url: BITUNIX_WITHDRAW_URL, active: true });
  await waitForTabComplete(tab.id);
  return getTab(updated.id || tab.id);
}

function sendToContent(
  tabId: number,
  type: 'tokenAutomationOrder' | 'tokenAutomationCompleteVerification',
  payload: Partial<RunOrderPayload> = {}
): Promise<ContentOrderResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        ...payload,
        type,
        text: payload.text || 'Bitunix withdraw'
      },
      (response: ContentOrderResponse | undefined) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || 'Content script did not complete the order'));
          return;
        }
        resolve(response);
      }
    );
  });
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

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Bitunix verification email from backend'));
    }, EMAIL_CODE_WAIT_TIMEOUT_MS);

    const onReady = (data: { orderId?: string; emailCode?: string }) => {
      if (data.orderId !== orderId || !data.emailCode?.trim()) return;
      cleanup();
      resolve(data.emailCode.trim());
    };

    const onFailed = (data: { orderId?: string; error?: string }) => {
      if (data.orderId !== orderId) return;
      cleanup();
      reject(new Error(data.error || 'Backend could not find verification email'));
    };

    function cleanup(): void {
      window.clearTimeout(timeoutId);
      socket?.off('extension:verification_code_ready', onReady);
      socket?.off('extension:verification_code_failed', onFailed);
    }

    socket.on('extension:verification_code_ready', onReady);
    socket.on('extension:verification_code_failed', onFailed);

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
  if (trimmed) return trimmed;

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
  const tab = await getActiveTab();
  const withdrawTab = await ensureWithdrawTab(tab);
  const tabId = await ensureContentScript(withdrawTab);
  setBitunixTabId(tabId);
  let result = await sendToContent(tabId, 'tokenAutomationOrder', payload);

  if (result.verificationRequired) {
    const emailCodeSentAt = result.emailCodeSentAt || Date.now();
    const emailCode = await resolveEmailCode(payload.orderId, emailCodeSentAt, payload.emailCode || result.emailCode);
    const authenticatorCode = await readAuthenticatorCode(payload.authenticatorCode);

    showVerificationCodes(emailCode, authenticatorCode);
    setMessage('Codes received. Filling Bitunix verification modal...');

    await updateTab(tabId, { active: true });
    await waitForTabComplete(tabId).catch(() => undefined);
    await ensureContentScript(await getTab(tabId));

    result = await sendToContent(tabId, 'tokenAutomationCompleteVerification', {
      ...payload,
      emailCode,
      authenticatorCode
    });
  }

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
  lastOrderEl.textContent = payload.orderId.slice(0, 8);
  hideVerificationCodes();
  setMessage('Running Bitunix withdraw order...');

  let bitunixTabId: number | undefined;

  try {
    const result = await withTimeout(
      executeWithdrawOrder(payload, (tabId) => {
        bitunixTabId = tabId;
      }),
      ORDER_TIMEOUT_MS,
      'Order timed out after 5 minutes'
    );

    socket?.emit('extension:order_result', {
      orderId: payload.orderId,
      status: 'completed',
      output: result
    });

    setMessage('Withdraw complete. Waiting before opening wallet...');
    await delay(POST_SUCCESS_WALLET_DELAY_MS);
    await moveToBitunixWallet(bitunixTabId, 'Opening Bitunix wallet...');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Order failed';
    socket?.emit('extension:order_result', {
      orderId: payload.orderId,
      status: 'failed',
      error: message
    });
    setMessage(message);
    await moveToBitunixWallet(bitunixTabId, 'Withdraw failed. Opening Bitunix wallet...');
  }
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
    if (runningOrderId) {
      socket?.emit('extension:order_result', {
        orderId: payload.orderId,
        status: 'failed',
        error: 'Extension is already running an order'
      });
      return;
    }

    runningOrderId = payload.orderId;
    void runOrder(payload).finally(() => {
      if (runningOrderId === payload.orderId) runningOrderId = null;
    });
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
