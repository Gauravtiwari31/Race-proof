import { z } from 'zod';

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9+#.-]{0,31}$/, 'Tags are 1-32 characters: letters, digits, + # . -');

/**
 * Asks the runtime rather than Intl.supportedValuesOf: that list holds one canonical name per zone
 * and can omit aliases such as Asia/Kolkata (it lists Asia/Calcutta) and UTC, both valid and in use.
 * The regex keeps out offsets like +05:30, which DateTimeFormat accepts but are not IANA names.
 */
function isIanaTimeZone(tz: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const tags = z
  .array(tag)
  .max(20)
  .transform((list) => [...new Set(list)]);
export const uuid = z.string().uuid();
export const name = z.string().trim().min(1).max(80);
export const timezone = z.string().max(64).refine(isIanaTimeZone, 'Unknown IANA time zone');
export const minuteOfDay = z.number().int().min(0).max(1439);

export const idParams = z.object({ id: uuid });
