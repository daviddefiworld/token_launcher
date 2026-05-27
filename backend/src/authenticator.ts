import { generateTotp } from './totp';

export function generateAuthenticatorCode(): string {
  const secret = process.env.GOOGLE_AUTHENTICATOR_SECRET?.trim();
  if (!secret) {
    throw new Error('GOOGLE_AUTHENTICATOR_SECRET is not configured in backend/.env');
  }
  return generateTotp(secret);
}
