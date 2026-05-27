import { createHmac } from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(secret: string): Buffer {
  const cleaned = secret.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = '';
  for (const char of cleaned) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error('Invalid authenticator secret');
    }
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function counterToBuffer(counter: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter % 0x100000000, 4);
  return buffer;
}

function dynamicTruncate(hmac: Buffer): number {
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return binary % 1_000_000;
}

export function generateTotp(secret: string, timestampMs = Date.now(), stepSeconds = 30): string {
  const normalizedSecret = secret.trim().replace(/^secret=/i, '');
  const key = base32Decode(normalizedSecret);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const hmac = createHmac('sha1', key).update(counterToBuffer(counter)).digest();
  return dynamicTruncate(hmac).toString().padStart(6, '0');
}
