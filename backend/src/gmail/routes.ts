import { Router } from 'express';
import {
  completeOAuthConnection,
  getConnectAuthUrl,
  getDashboardRedirectUrl,
  isGmailConfigured,
  listPublicGmailAccounts,
  listPublicMessages,
  syncAllGmailAccounts,
  syncGmailAccount,
  waitForVerificationCode
} from './service';
import { publicAccountView, removeGmailAccount, setDefaultGmailAccount } from './store';

export const gmailRouter = Router();

gmailRouter.get('/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      configured: isGmailConfigured(),
      accounts: listPublicGmailAccounts()
    }
  });
});

gmailRouter.get('/', (_req, res) => {
  res.json({ success: true, data: listPublicGmailAccounts() });
});

gmailRouter.get('/messages', (req, res) => {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
  res.json({ success: true, data: listPublicMessages(accountId) });
});

gmailRouter.get('/connect-url', (_req, res) => {
  try {
    res.json({ success: true, data: { url: getConnectAuthUrl() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gmail is not configured';
    res.status(503).json({ success: false, error: message });
  }
});

gmailRouter.get('/oauth/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) {
    res.redirect(getDashboardRedirectUrl({ error: 'missing_code' }));
    return;
  }

  try {
    const account = await completeOAuthConnection(code);
    res.redirect(getDashboardRedirectUrl({ connected: account.id }));
  } catch (error) {
    const message =
      error && typeof error === 'object' && 'response' in error
        ? ((error as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ??
          'OAuth failed')
        : error instanceof Error
          ? error.message
          : 'OAuth failed';
    res.redirect(getDashboardRedirectUrl({ error: message }));
  }
});

gmailRouter.get('/wait-for-code', async (req, res) => {
  const sentAt = Number(req.query.sentAt);
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;

  if (!Number.isFinite(sentAt)) {
    res.status(400).json({ success: false, error: 'sentAt query parameter is required' });
    return;
  }

  try {
    const result = await waitForVerificationCode(sentAt, { accountId });
    res.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not find verification code';
    res.status(504).json({ success: false, error: message });
  }
});

gmailRouter.post('/sync', async (_req, res) => {
  try {
    const accounts = await syncAllGmailAccounts();
    res.json({ success: true, data: accounts.map(publicAccountView) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    res.status(500).json({ success: false, error: message });
  }
});

gmailRouter.post('/:accountId/sync', async (req, res) => {
  try {
    const account = await syncGmailAccount(req.params.accountId);
    res.json({ success: true, data: publicAccountView(account) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    res.status(500).json({ success: false, error: message });
  }
});

gmailRouter.post('/:accountId/default', (req, res) => {
  const account = setDefaultGmailAccount(req.params.accountId);
  if (!account) {
    res.status(404).json({ success: false, error: 'Gmail account not found' });
    return;
  }
  res.json({ success: true, data: publicAccountView(account) });
});

gmailRouter.delete('/:accountId', (req, res) => {
  const removed = removeGmailAccount(req.params.accountId);
  if (!removed) {
    res.status(404).json({ success: false, error: 'Gmail account not found' });
    return;
  }
  res.json({ success: true });
});
