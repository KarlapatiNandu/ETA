import Papa from "papaparse";
import { z } from "zod";

/**
 * The TD roster CSV (BUILD_PLAN Stage 4). One definition shared by the admin preview, the
 * import job and any client-side pre-check.
 *
 * Rows without a phone number are VALID — only claiming needs one (SCHEMA §1).
 */

/** Indian mobile → E.164. Accepts the ways people actually type it; null if blank. */
export function normalisePhone(raw: string | null | undefined): string | null | undefined {
  if (raw == null || raw.trim() === "") return null;
  let digits = raw.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.startsWith("0091")) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : undefined;
}

export const RosterRow = z.object({
  roll_no: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{4,20}$/, "must be 4–20 letters or digits"),
  full_name: z.string().trim().min(1, "is required").max(120),
  admission_year: z.coerce
    .number({ error: "must be a year" })
    .int("must be a year")
    .min(2000, "must be 2000 or later")
    .max(2100, "must be a year"),
  phone_e164: z
    .string()
    .nullable()
    .optional()
    .transform((v, ctx) => {
      const p = normalisePhone(v);
      if (p === undefined) {
        ctx.addIssue({ code: "custom", message: "is not a valid Indian mobile number" });
        return z.NEVER;
      }
      return p;
    }),
  branch: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
});
export type RosterRow = z.infer<typeof RosterRow>;

export interface CsvError {
  /** 1-based line number as the spreadsheet shows it (header is line 1). */
  row: number;
  column: string;
  message: string;
}

const HEADER_ALIASES: Record<string, keyof RosterRow> = {
  roll_no: "roll_no",
  rollno: "roll_no",
  roll_number: "roll_no",
  roll: "roll_no",
  name: "full_name",
  full_name: "full_name",
  student_name: "full_name",
  admission_year: "admission_year",
  year_of_admission: "admission_year",
  batch: "admission_year",
  phone: "phone_e164",
  phone_e164: "phone_e164",
  mobile: "phone_e164",
  mobile_no: "phone_e164",
  mobile_number: "phone_e164",
  phone_number: "phone_e164",
  branch: "branch",
  department: "branch",
};
const REQUIRED: (keyof RosterRow)[] = ["roll_no", "full_name", "admission_year"];

const canon = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/**
 * Parse and validate a roster CSV. Never throws on bad data: every problem comes back as a
 * per-row, per-column error so the admin preview can show all of them at once.
 */
export function parseRosterCsv(text: string): { rows: RosterRow[]; errors: CsvError[] } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => HEADER_ALIASES[canon(h)] ?? `?${h.trim()}`,
  });
  const errors: CsvError[] = [];
  const headers = parsed.meta.fields ?? [];
  const missing = REQUIRED.filter((c) => !headers.includes(c));
  if (missing.length) {
    return {
      rows: [],
      errors: missing.map((c) => ({
        row: 1,
        column: c,
        message: "column is missing from the header",
      })),
    };
  }

  const rows: RosterRow[] = [];
  const firstSeen = new Map<string, number>();
  parsed.data.forEach((raw, i) => {
    const line = i + 2;
    const result = RosterRow.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({ row: line, column: String(issue.path[0] ?? "?"), message: issue.message });
      }
      return;
    }
    const dup = firstSeen.get(result.data.roll_no);
    if (dup) {
      errors.push({ row: line, column: "roll_no", message: `duplicates line ${dup}` });
      return;
    }
    firstSeen.set(result.data.roll_no, line);
    rows.push(result.data);
  });
  for (const e of parsed.errors) {
    errors.push({ row: (e.row ?? 0) + 2, column: "?", message: e.message });
  }
  errors.sort((a, b) => a.row - b.row);
  return { rows, errors };
}
