import { randomUUID } from 'crypto';
import { google, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import {
  appendCachedMessages,
  getDefaultGmailAccount,
  getGmailAccount,
  isMessageUsed,
  listCachedMessages,
  listGmailAccounts,
  markMessageUsed,
  publicAccountView,
  replaceCachedMessages,
  updateGmailAccount,
  upsertGmailAccount
} from './store';
import {
  BITUNIX_NOTIFICATION_EMAIL,
  collectMessageText,
  extractVerificationCode,
  isBitunixSender,
  isNearSendTime
} from './parser';
import type { CachedGmailMessage, GmailAccount, GmailTokens } from './types';

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const SYNC_INTERVAL_MS = 60_000;
const WAIT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

function getOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() || `http://localhost:${process.env.PORT || 5050}/api/gmails/oauth/callback`;
  const dashboardUrl = process.env.DASHBOARD_URL?.trim() || 'http://localhost:4050';

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Gmail integration');
  }

  return { clientId, clientSecret, redirectUri, dashboardUrl };
}

function mergeTokens(existing: GmailTokens, incoming: Partial<GmailTokens>): GmailTokens {
  return {
    access_token: incoming.access_token ?? existing.access_token,
    refresh_token: incoming.refresh_token ?? existing.refresh_token,
    expiry_date: incoming.expiry_date ?? existing.expiry_date,
    scope: incoming.scope ?? existing.scope,
    token_type: incoming.token_type ?? existing.token_type,
    id_token: incoming.id_token ?? existing.id_token
  };
}

function credentialsFromTokens(tokens: GmailTokens) {
  return {
    access_token: tokens.access_token || undefined,
    refresh_token: tokens.refresh_token || undefined,
    expiry_date: tokens.expiry_date || undefined,
    scope: tokens.scope || undefined,
    token_type: tokens.token_type || undefined,
    id_token: tokens.id_token || undefined
  };
}

function createOAuthClient(tokens?: GmailTokens): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  if (tokens) {
    client.setCredentials(credentialsFromTokens(tokens));
  }
  return client;
}

async function getAuthenticatedClient(account: GmailAccount): Promise<OAuth2Client> {
  if (!account.tokens.refresh_token && !account.tokens.access_token) {
    throw new Error('Gmail account has no OAuth tokens. Disconnect it and connect again.');
  }

  const auth = createOAuthClient(account.tokens);
  auth.on('tokens', (newTokens) => {
    updateGmailAccount(account.id, {
      tokens: mergeTokens(account.tokens, newTokens)
    });
  });

  const tokenResponse = await auth.getAccessToken();
  const accessToken = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!accessToken) {
    throw new Error('Gmail access token expired or missing. Disconnect the account and connect again.');
  }

  return auth;
}

async function resolveAccountEmail(auth: OAuth2Client): Promise<string> {
  const gmail = google.gmail({ version: 'v1', auth });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress?.trim();
  if (!email) {
    throw new Error('Gmail did not return an email address for this account');
  }
  return email;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getHeaderValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const header = headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

function toCachedMessage(accountId: string, message: gmail_v1.Schema$Message): CachedGmailMessage | null {
  if (!message.id || !message.internalDate) return null;
  const from = getHeaderValue(message.payload?.headers, 'From');
  const subject = getHeaderValue(message.payload?.headers, 'Subject');
  const text = collectMessageText(message.payload || {});
  const verificationCode = extractVerificationCode(`${subject}\n${text}\n${message.snippet || ''}`);
  return {
    id: message.id,
    accountId,
    subject,
    from,
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    snippet: message.snippet || '',
    verificationCode: verificationCode || undefined
  };
}

async function getGmailClient(account: GmailAccount): Promise<gmail_v1.Gmail> {
  const auth = await getAuthenticatedClient(account);
  return google.gmail({ version: 'v1', auth });
}

async function fetchBitunixMessages(account: GmailAccount, maxResults = 5): Promise<CachedGmailMessage[]> {
  const gmail = await getGmailClient(account);
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `from:${BITUNIX_NOTIFICATION_EMAIL} newer_than:2d`,
    maxResults
  });

  const ids = list.data.messages?.map((message) => message.id).filter(Boolean) as string[] | undefined;
  if (!ids?.length) return [];

  const messages: CachedGmailMessage[] = [];
  for (const id of ids) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full'
    });
    const cached = toCachedMessage(account.id, full.data);
    if (cached) messages.push(cached);
  }
  return messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export function getConnectAuthUrl(): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES
  });
}

export async function completeOAuthConnection(code: string): Promise<GmailAccount> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token && !tokens.refresh_token) {
    throw new Error('Google did not return OAuth tokens. Verify GOOGLE_REDIRECT_URI matches Google Cloud exactly.');
  }

  client.setCredentials(tokens);

  const accessToken = await client.getAccessToken();
  if (!accessToken.token) {
    throw new Error('Could not obtain a Gmail access token after OAuth. Try connecting again.');
  }

  const email = await resolveAccountEmail(client);

  const existing = listGmailAccounts().find((account) => account.email.toLowerCase() === email.toLowerCase());
  const storedTokens: GmailTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? existing?.tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    scope: tokens.scope || undefined,
    token_type: tokens.token_type || undefined,
    id_token: tokens.id_token || undefined
  };

  if (!storedTokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove the app from your Google Account permissions and connect again.');
  }

  const account: GmailAccount = {
    id: existing?.id || randomUUID(),
    email,
    connectedAt: existing?.connectedAt || nowIso(),
    lastSyncAt: nowIso(),
    isDefault: existing?.isDefault ?? listGmailAccounts().length === 0,
    tokens: storedTokens
  };

  const saved = upsertGmailAccount(account);
  return syncGmailAccount(saved.id);
}

export async function syncGmailAccount(accountId: string): Promise<GmailAccount> {
  const account = getGmailAccount(accountId);
  if (!account) {
    throw new Error(`Gmail account ${accountId} not found`);
  }

  try {
    const messages = await fetchBitunixMessages(account);
    replaceCachedMessages(accountId, messages);
    return (
      updateGmailAccount(accountId, {
        lastSyncAt: nowIso(),
        lastError: undefined
      }) || account
    );
  } catch (error) {
    const message = formatGmailError(error);
    updateGmailAccount(accountId, { lastError: message });
    throw new Error(message);
  }
}

export async function syncAllGmailAccounts(): Promise<GmailAccount[]> {
  const results: GmailAccount[] = [];
  for (const account of listGmailAccounts()) {
    try {
      results.push(await syncGmailAccount(account.id));
    } catch {
      results.push(getGmailAccount(account.id) || account);
    }
  }
  return results;
}

function findCodeInMessages(messages: CachedGmailMessage[], sentAt: number): { code: string; message: CachedGmailMessage } | null {
  for (const message of messages) {
    if (isMessageUsed(message.accountId, message.id)) continue;
    if (!isBitunixSender(message.from)) continue;
    const receivedAtMs = new Date(message.receivedAt).getTime();
    if (!isNearSendTime(receivedAtMs, sentAt)) continue;
    const code = message.verificationCode || extractVerificationCode(`${message.subject}\n${message.snippet}`);
    if (code) return { code, message };
  }
  return null;
}

export async function waitForVerificationCode(
  sentAt: number,
  options?: { accountId?: string; orderId?: string }
): Promise<{ emailCode: string; accountId: string; messageId: string }> {
  const accountId = options?.accountId;
  const orderId = options?.orderId;
  if (!Number.isFinite(sentAt)) {
    throw new Error('sentAt is required');
  }

  const accounts = accountId
    ? [getGmailAccount(accountId)].filter((account): account is GmailAccount => Boolean(account))
    : listGmailAccounts();

  if (accounts.length === 0) {
    throw new Error('No Gmail accounts connected. Connect one in the dashboard Gmails tab.');
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
    for (const account of accounts) {
      try {
        const fresh = await fetchBitunixMessages(account, 5);
        appendCachedMessages(account.id, fresh);
        const cached = listCachedMessages(account.id);
        const match =
          findCodeInMessages(fresh, sentAt) || findCodeInMessages(cached, sentAt);
        if (match) {
          markMessageUsed({
            accountId: match.message.accountId,
            messageId: match.message.id,
            orderId
          });
          return {
            emailCode: match.code,
            accountId: match.message.accountId,
            messageId: match.message.id
          };
        }
        updateGmailAccount(account.id, { lastSyncAt: nowIso(), lastError: undefined });
      } catch (error) {
        const message = formatGmailError(error);
        updateGmailAccount(account.id, { lastError: message });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error('Timed out waiting for Bitunix verification email');
}

export function listPublicGmailAccounts() {
  return listGmailAccounts().map(publicAccountView);
}

export function listPublicMessages(accountId?: string) {
  return listCachedMessages(accountId);
}

export function getDashboardRedirectUrl(query: Record<string, string>): string {
  const { dashboardUrl } = getOAuthConfig();
  const url = new URL(`${dashboardUrl.replace(/\/$/, '')}/gmails`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

let syncTimer: NodeJS.Timeout | null = null;

export function startGmailSyncLoop(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    if (listGmailAccounts().length === 0) return;
    void syncAllGmailAccounts();
  }, SYNC_INTERVAL_MS);
}

export function isGmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

export function getDefaultAccountId(): string | undefined {
  return getDefaultGmailAccount()?.id;
}

function formatGmailError(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { error?: { message?: string } } } }).response;
    const apiMessage = response?.data?.error?.message;
    if (apiMessage) {
      if (/missing required authentication credential/i.test(apiMessage)) {
        return 'Gmail session is invalid. Disconnect the account on the Gmails tab and connect again.';
      }
      return apiMessage;
    }
  }
  return error instanceof Error ? error.message : 'Gmail sync failed';
}
