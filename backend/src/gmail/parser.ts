export const BITUNIX_NOTIFICATION_EMAIL = 'notifications@bitunix.com';
export const EMAIL_TIME_TOLERANCE_MS = 2 * 60 * 1000;
const LABELED_CODE_PATTERNS = [
  /verification\s*code\s*[:：]?\s*(\d{6})\b/i,
  /(?:security|email)\s*(?:verification\s*)?code\s*[:：]?\s*(\d{6})\b/i,
  /code\s*[:：]\s*(\d{6})\b/i
];

export function extractVerificationCode(text: string): string | null {
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
    if (code && isLikelyVerificationCode(searchText, match.index ?? searchText.indexOf(code))) {
      return code;
    }
  }

  return null;
}

function isLikelyVerificationCode(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 12), index);
  const after = text.slice(index + 6, index + 16);

  if (/[.:]\s*$/.test(before) || before.endsWith('.')) {
    return false;
  }

  if (/^\s*(?:eth|btc|usdt|usd)\b/i.test(after)) {
    return false;
  }

  if (/\d{4}-\d{2}-$/.test(before) || /^\d{2}:\d{2}/.test(after)) {
    return false;
  }

  if (/0x[a-f0-9]*$/i.test(before)) {
    return false;
  }

  if (/verification|security|code/i.test(before)) {
    return true;
  }

  return !/\d/.test(before.slice(-1)) || /(?:code|otp|pin)\s*$/i.test(before);
}

export function isBitunixSender(fromHeader: string): boolean {
  return fromHeader.toLowerCase().includes(BITUNIX_NOTIFICATION_EMAIL);
}

export function isNearSendTime(messageTimeMs: number, sentAt: number): boolean {
  return Math.abs(messageTimeMs - sentAt) <= EMAIL_TIME_TOLERANCE_MS;
}
export function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function collectMessageText(payload: { body?: { data?: string | null }; parts?: Array<{ mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] }> }): string {
  const chunks: string[] = [];

  const walk = (part: { mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] }) => {
    if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (part.mimeType === 'text/html') {
        chunks.push(decoded.replace(/<[^>]+>/g, ' '));
      } else {
        chunks.push(decoded);
      }
    }
    if (Array.isArray(part.parts)) {
      part.parts.forEach((child) => walk(child as typeof part));
    }
  };

  if (payload.body?.data) {
    chunks.push(decodeBase64Url(payload.body.data));
  }
  if (Array.isArray(payload.parts)) {
    payload.parts.forEach((part) => walk(part as { mimeType?: string | null; body?: { data?: string | null }; parts?: unknown[] }));
  }

  return chunks.join('\n');
}
