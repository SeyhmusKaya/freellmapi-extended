import crypto from 'crypto';

// Crockford's base32 alphabet (no I,L,O,U)
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ALPHABET.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    out = ALPHABET[mod] + out;
    now = (now - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = crypto.randomBytes(RANDOM_LEN);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ALPHABET[bytes[i] % ENCODING_LEN];
  }
  return out;
}

export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

export function batchId(): string {
  return `batch_${ulid()}`;
}
