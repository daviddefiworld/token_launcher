import { randomUUID } from 'crypto';
import { google, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { CachedGmailMessage, GmailAccount, GmailTokens } from './types';
import { GmailRepository, nowIso } from './persist';

export const BITUNIX_NOTIFICATION_EMAIL = 'notifications@bitunix.com';
const EMAIL_TIME_TOLERANCE_MS = 2 * 60 * 1000;
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const SYNC_INTERVAL_MS = 60_000;
const WAIT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

const LABELED_CODE_PATTERNS = [
  /verification\s*code\s*[:：]?\s*(\d{6})\b/i,
  /(?:security|email)\s*(?:verification\s*)?code\s*[:：]?\s*(\d{6})\b/i,
  /code\s*[:：]\s*(\d{6})\b/i
];

export class BitunixEmailParser {
  static extractCode(text: string): string | null {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return null;

    for (const pattern of LABELED_CODE_PATTERNS) {
      const match = pattern.exec(normalized);
      if (match?.[1]) return match[1];
    }

    const lines = normalized
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const relevant = lines.filter((line) => /bitunix|withdraw|verification|security|code/i.test(line));

    for (const line of relevant) {
      for (const pattern of LABELED_CODE_PATTERNS) {
        const match = pattern.exec(line);
        if (match?.[1]) return match[1];
      }
    }

    const searchText = relevant.length > 0 ? relevant.join('\n') : normalized;
    for (const match of searchText.matchAll(/\b(\d{6})\b/g)) {
      const code = match[1];
      if (code && BitunixEmailParser.isLikelyCode(searchText, match.index ?? searchText.indexOf(code))) {
        return code;
      }
    }
    return null;
  }

  private static isLikelyCode(text: string, index: number): boolean {
    const before = text.slice(Math.max(0, index - 12), index);
    const after = text.slice(index + 6, index + 16);
    if (/[.:]\s*$/.test(before) || before.endsWith('.')) return false;
    if (/^\s*(?:eth|btc|usdt|usd)\b/i.test(after)) return false;
    if (/\d{4}-\d{2}-$/.test(before) || /^\d{2}:\d{2}/.test(after)) return false;
    if (/0x[a-f0-9]*$/i.test(before)) return false;
    if (/verification|security|code/i.test(before)) return true;
    return !/\d/.test(before.slice(-1)) || /(?:code|otp|pin)\s*$/i.test(before);
  }

  static isBitunixSender(fromHeader: string): boolean {
    return fromHeader.toLowerCase().includes(BITUNIX_NOTIFICATION_EMAIL);
  }

  static isNearSendTime(messageTimeMs: number, sentAt: number): boolean {
    return Math.abs(messageTimeMs - sentAt) <= EMAIL_TIME_TOLERANCE_MS;
  }

  static collectBodyText(payload: {
    body?: { data?: string | null };
    parts?: Array<{ mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] }>;
  }): string {
    const chunks: string[] = [];
    const walk = (part: { mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] }) => {
      if (part.body?.data) {
        const decoded = BitunixEmailParser.decodeBase64Url(part.body.data);
        chunks.push(part.mimeType === 'text/html' ? decoded.replace(/<[^>]+>/g, ' ') : decoded);
      }
      if (Array.isArray(part.parts)) {
        part.parts.forEach((child) => walk(child as typeof part));
      }
    };
    if (payload.body?.data) chunks.push(BitunixEmailParser.decodeBase64Url(payload.body.data));
    if (Array.isArray(payload.parts)) {
      payload.parts.forEach((part) => walk(part as { mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] }));
    }
    return chunks.join('\n');
  }

  private static decodeBase64Url(value: string): string {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  }
}

export class GmailService {
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(private readonly store: GmailRepository) {}

  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
  }

  getConnectUrl(): string {
    return this.createOAuthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GMAIL_SCOPES
    });
  }

  getDashboardRedirectUrl(query: Record<string, string>): string {
    const { dashboardUrl } = this.oauthConfig();
    const url = new URL(`${dashboardUrl.replace(/\/$/, '')}/gmails`);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.toString();
  }

  listPublicAccounts() {
    return this.store.listAccounts().map((a) => this.store.publicView(a));
  }

  listPublicMessages(accountId?: string) {
    return this.store.listMessages(accountId);
  }

  getDefaultAccountId(): string | undefined {
    return this.store.getDefaultAccount()?.id;
  }

  async completeOAuth(code: string): Promise<GmailAccount> {
    const client = this.createOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token && !tokens.refresh_token) {
      throw new Error('Google did not return OAuth tokens. Verify GOOGLE_REDIRECT_URI matches Google Cloud exactly.');
    }
    client.setCredentials(tokens);
    const accessToken = await client.getAccessToken();
    if (!accessToken.token) {
      throw new Error('Could not obtain a Gmail access token after OAuth. Try connecting again.');
    }

    const email = await this.resolveEmail(client);
    const existing = this.store.listAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
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
      isDefault: existing?.isDefault ?? this.store.listAccounts().length === 0,
      tokens: storedTokens
    };
    this.store.upsertAccount(account);
    return this.syncAccount(account.id);
  }

  async syncAccount(accountId: string): Promise<GmailAccount> {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error(`Gmail account ${accountId} not found`);
    try {
      const messages = await this.fetchBitunixMessages(account);
      this.store.replaceMessages(accountId, messages);
      return this.store.updateAccount(accountId, { lastSyncAt: nowIso(), lastError: undefined }) || account;
    } catch (error) {
      const message = GmailService.formatError(error);
      this.store.updateAccount(accountId, { lastError: message });
      throw new Error(message);
    }
  }

  async syncAll(): Promise<GmailAccount[]> {
    const results: GmailAccount[] = [];
    for (const account of this.store.listAccounts()) {
      try {
        results.push(await this.syncAccount(account.id));
      } catch {
        results.push(this.store.getAccount(account.id) || account);
      }
    }
    return results;
  }

  startSyncLoop(): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => {
      if (this.store.listAccounts().length === 0) return;
      void this.syncAll();
    }, SYNC_INTERVAL_MS);
  }

  async waitForVerificationCode(
    sentAt: number,
    options?: { accountId?: string; orderId?: string }
  ): Promise<{ emailCode: string; accountId: string; messageId: string }> {
    if (!Number.isFinite(sentAt)) throw new Error('sentAt is required');

    const accounts = options?.accountId
      ? [this.store.getAccount(options.accountId)].filter((a): a is GmailAccount => Boolean(a))
      : this.store.listAccounts();
    if (accounts.length === 0) {
      throw new Error('No Gmail accounts connected. Connect one in the dashboard Gmails tab.');
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
      for (const account of accounts) {
        try {
          const fresh = await this.fetchBitunixMessages(account, 5);
          this.store.appendMessages(account.id, fresh);
          const cached = this.store.listMessages(account.id);
          const match =
            this.findCodeInMessages(fresh, sentAt) || this.findCodeInMessages(cached, sentAt);
          if (match) {
            this.store.markMessageUsed({
              accountId: match.message.accountId,
              messageId: match.message.id,
              orderId: options?.orderId
            });
            return { emailCode: match.code, accountId: match.message.accountId, messageId: match.message.id };
          }
          this.store.updateAccount(account.id, { lastSyncAt: nowIso(), lastError: undefined });
        } catch (error) {
          this.store.updateAccount(account.id, { lastError: GmailService.formatError(error) });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error('Timed out waiting for Bitunix verification email');
  }

  private findCodeInMessages(
    messages: CachedGmailMessage[],
    sentAt: number
  ): { code: string; message: CachedGmailMessage } | null {
    for (const message of messages) {
      if (this.store.isMessageUsed(message.accountId, message.id)) continue;
      if (!BitunixEmailParser.isBitunixSender(message.from)) continue;
      if (!BitunixEmailParser.isNearSendTime(new Date(message.receivedAt).getTime(), sentAt)) continue;
      const code = message.verificationCode || BitunixEmailParser.extractCode(`${message.subject}\n${message.snippet}`);
      if (code) return { code, message };
    }
    return null;
  }

  private async fetchBitunixMessages(account: GmailAccount, maxResults = 5): Promise<CachedGmailMessage[]> {
    const gmail = google.gmail({ version: 'v1', auth: await this.authenticatedClient(account) });
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `from:${BITUNIX_NOTIFICATION_EMAIL} newer_than:2d`,
      maxResults
    });
    const ids = list.data.messages?.map((m) => m.id).filter(Boolean) as string[] | undefined;
    if (!ids?.length) return [];

    const messages: CachedGmailMessage[] = [];
    for (const id of ids) {
      const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const cached = this.toCachedMessage(account.id, full.data);
      if (cached) messages.push(cached);
    }
    return messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  private toCachedMessage(accountId: string, message: gmail_v1.Schema$Message): CachedGmailMessage | null {
    if (!message.id || !message.internalDate) return null;
    const from = this.header(message.payload?.headers, 'From');
    const subject = this.header(message.payload?.headers, 'Subject');
    const text = BitunixEmailParser.collectBodyText(message.payload || {});
    const verificationCode = BitunixEmailParser.extractCode(`${subject}\n${text}\n${message.snippet || ''}`);
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

  private header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
    const header = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
    return header?.value || '';
  }

  private async resolveEmail(auth: OAuth2Client): Promise<string> {
    const profile = await google.gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress?.trim();
    if (!email) throw new Error('Gmail did not return an email address for this account');
    return email;
  }

  private async authenticatedClient(account: GmailAccount): Promise<OAuth2Client> {
    if (!account.tokens.refresh_token && !account.tokens.access_token) {
      throw new Error('Gmail account has no OAuth tokens. Disconnect it and connect again.');
    }
    const auth = this.createOAuthClient(account.tokens);
    auth.on('tokens', (newTokens) => {
      this.store.updateAccount(account.id, { tokens: this.mergeTokens(account.tokens, newTokens) });
    });
    const tokenResponse = await auth.getAccessToken();
    const accessToken = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
    if (!accessToken) {
      throw new Error('Gmail access token expired or missing. Disconnect the account and connect again.');
    }
    return auth;
  }

  private oauthConfig() {
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

  private createOAuthClient(tokens?: GmailTokens): OAuth2Client {
    const { clientId, clientSecret, redirectUri } = this.oauthConfig();
    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    if (tokens) client.setCredentials(this.credentialsFromTokens(tokens));
    return client;
  }

  private mergeTokens(existing: GmailTokens, incoming: Partial<GmailTokens>): GmailTokens {
    return {
      access_token: incoming.access_token ?? existing.access_token,
      refresh_token: incoming.refresh_token ?? existing.refresh_token,
      expiry_date: incoming.expiry_date ?? existing.expiry_date,
      scope: incoming.scope ?? existing.scope,
      token_type: incoming.token_type ?? existing.token_type,
      id_token: incoming.id_token ?? existing.id_token
    };
  }

  private credentialsFromTokens(tokens: GmailTokens) {
    return {
      access_token: tokens.access_token || undefined,
      refresh_token: tokens.refresh_token || undefined,
      expiry_date: tokens.expiry_date || undefined,
      scope: tokens.scope || undefined,
      token_type: tokens.token_type || undefined,
      id_token: tokens.id_token || undefined
    };
  }

  private static formatError(error: unknown): string {
    if (error && typeof error === 'object' && 'response' in error) {
      const apiMessage = (error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error
        ?.message;
      if (apiMessage) {
        if (/missing required authentication credential/i.test(apiMessage)) {
          return 'Gmail session is invalid. Disconnect the account on the Gmails tab and connect again.';
        }
        return apiMessage;
      }
    }
    return error instanceof Error ? error.message : 'Gmail sync failed';
  }
}
