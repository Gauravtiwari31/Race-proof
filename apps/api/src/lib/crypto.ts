import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (input: string): Buffer => createHash('sha256').update(input).digest();

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 Crockford base32 characters = 50 random bits, formatted TEAM-7KQ2-M9XD-H4. */
export function generateInviteCode(): string {
  // 32 divides 256, so masking to 5 bits keeps the distribution uniform.
  const chars = Array.from(randomBytes(10), (b) => CROCKFORD[b & 31]).join('');
  return `TEAM-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Forgives case, separators and read-aloud confusions. Returns null if it cannot be a code. */
export function canonicalInviteCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/^\s*TEAM/, '')
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code) ? code : null;
}
