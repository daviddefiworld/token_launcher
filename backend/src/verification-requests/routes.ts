import { Router } from 'express';
import { listVerificationRequests } from './store';
import { getPublicVerificationRequest, startVerificationCodeRequest } from './service';

export const verificationRequestsRouter = Router();

verificationRequestsRouter.post('/', (req, res) => {
  const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';
  const extensionId = typeof req.body?.extensionId === 'string' ? req.body.extensionId.trim() : '';
  const emailCodeSentAt = Number(req.body?.emailCodeSentAt);

  if (!orderId) {
    res.status(400).json({ success: false, error: 'orderId is required' });
    return;
  }
  if (!extensionId) {
    res.status(400).json({ success: false, error: 'extensionId is required' });
    return;
  }
  if (!Number.isFinite(emailCodeSentAt)) {
    res.status(400).json({ success: false, error: 'emailCodeSentAt is required' });
    return;
  }

  const request = startVerificationCodeRequest({ orderId, extensionId, emailCodeSentAt });
  res.status(201).json({ success: true, data: request });
});

verificationRequestsRouter.get('/:requestId', (req, res) => {
  const request = getPublicVerificationRequest(req.params.requestId);
  if (!request) {
    res.status(404).json({ success: false, error: 'Verification request not found' });
    return;
  }
  res.json({ success: true, data: request });
});

verificationRequestsRouter.get('/', (req, res) => {
  const extensionId = typeof req.query.extensionId === 'string' ? req.query.extensionId : undefined;
  res.json({ success: true, data: listVerificationRequests(extensionId) });
});
