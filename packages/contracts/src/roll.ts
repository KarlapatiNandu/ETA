/** Roll numbers are compared in one canonical form everywhere: trimmed, upper-case. */
export function normaliseRollNo(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Supabase Auth needs an email identity; students may have none. The synthetic address is
 * non-routable by design (SCHEMA §1) — which is why recovery runs over SMS, not email.
 */
export function syntheticEmail(rollNo: string): string {
  return `${normaliseRollNo(rollNo).toLowerCase()}@students.busmitra.internal`;
}
