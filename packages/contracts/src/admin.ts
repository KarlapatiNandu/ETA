import Papa from "papaparse";
import { z } from "zod";
import type { CsvError } from "./roster.ts";
import { normalisePhone } from "./roster.ts";

/**
 * The admin console ↔ gateway (BUILD_PLAN Stage 7). The rule this file exists to carry:
 * nothing reaches students without a rendered preview, a resolved recipient count and an
 * explicit confirmation (invariant 11) — so every request that notifies anyone carries the
 * count the admin was shown, and the gateway refuses it if the audience has changed since.
 */

// ── tiers ────────────────────────────────────────────────────────────────

/** ARCH §6.1, in the words the composer shows a non-technical TD member. */
export const TIERS = [
  {
    tier: 0,
    name: "Critical",
    effect: "Buzzes every phone, sends an SMS as well, and stays on screen until acknowledged.",
    use: "A bus cancelled or out of commission. Rarely anything else.",
  },
  {
    tier: 1,
    name: "Urgent",
    effect: "Buzzes the phone at once; SMS if the student has no working push.",
    use: "Something a student must act on in the next few minutes.",
  },
  {
    tier: 2,
    name: "Important",
    effect: "A normal notification on the phone.",
    use: "A changed bus list, a delay over 15 minutes, a general announcement.",
  },
  {
    tier: 3,
    name: "Info",
    effect: "A quiet notification; students who chose fewer alerts will not see it pop up.",
    use: "Nice to know.",
  },
  {
    tier: 4,
    name: "In-app only",
    effect: "No buzz at all — it only appears in the app's notification list.",
    use: "Background information.",
  },
] as const;

export const Tier = z.number().int().min(0).max(4);

/**
 * The typed confirmation for a T0 send: the admin types the number of students it will reach.
 * Typing a number forces reading it; "yes" does not.
 */
export const t0ConfirmText = (count: number) => String(count);

/** Every notifying request carries what the admin was shown. */
export const Confirmation = z.object({
  /** the recipient count on the confirmation dialog; must equal the count the gateway resolves */
  confirm_count: z.number().int().nonnegative(),
  /** T0 only: the count typed out (t0ConfirmText) */
  confirm_text: z.string().trim().max(20).optional(),
});
export type Confirmation = z.infer<typeof Confirmation>;

// ── fleet ────────────────────────────────────────────────────────────────

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

export const BusInput = z.object({
  bus_number: z
    .string()
    .trim()
    .min(1, "is required")
    .max(12)
    .regex(/^[A-Za-z0-9-]+$/, "letters, digits and '-' only"),
  registration_no: optText(20).transform((v) => (v ? v.toUpperCase().replace(/\s+/g, "") : null)),
  capacity: z.number().int().min(1).max(120).nullable().optional(),
  default_route_id: z.uuid().nullable().optional(),
  driver_id: z.uuid().nullable().optional(),
});
export type BusInput = z.infer<typeof BusInput>;

export const BusStatus = z.enum(["active", "maintenance", "out_of_commission", "retired"]);
export type BusStatus = z.infer<typeof BusStatus>;

/**
 * PUT /v1/admin/buses/:id/status. `out_of_commission` opens a ticket and fires T0 to everyone
 * connected to the bus, so it carries a Confirmation; returning to service resolves that ticket
 * (T2 on the same card) and is done from the ticket.
 */
export const BusStatusChange = z.object({
  status: BusStatus,
  note: z.string().trim().min(1, "say why").max(500).optional(),
  ...Confirmation.partial().shape,
});
export type BusStatusChange = z.infer<typeof BusStatusChange>;

export const DriverInput = z.object({
  full_name: z.string().trim().min(1, "is required").max(120),
  phone: z
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
  active: z.boolean().optional(),
});
export type DriverInput = z.infer<typeof DriverInput>;

// ── audiences ────────────────────────────────────────────────────────────

export const AudienceKind = z.enum(["all", "juniors", "seniors", "route", "bus", "custom"]);
export type AudienceKind = z.infer<typeof AudienceKind>;

/** Who an announcement is for. Custom audiences name students by roll number. */
export const AudienceSpec = z
  .object({
    audience: AudienceKind,
    audience_ref: z.uuid().nullable().optional(),
    roll_nos: z.array(z.string().trim().toUpperCase().min(1).max(20)).max(2000).optional(),
  })
  .refine(
    (a) => (a.audience === "route" || a.audience === "bus") === !!a.audience_ref,
    "a route or bus audience names exactly one route or bus",
  )
  .refine(
    (a) => a.audience !== "custom" || (a.roll_nos?.length ?? 0) > 0,
    "a custom audience needs at least one roll number",
  );
export type AudienceSpec = z.infer<typeof AudienceSpec>;

export const AudiencePreview = z.object({
  count: z.number().int(),
  /** custom audiences: roll numbers that are not a claimed account (they cannot be notified) */
  unmatched: z.array(z.string()).default([]),
});
export type AudiencePreview = z.infer<typeof AudiencePreview>;

// ── announcements ────────────────────────────────────────────────────────

export const AnnouncementDraft = z.object({
  tier: Tier,
  title: z.string().trim().min(1, "is required").max(80),
  body_md: z.string().trim().min(1, "is required").max(2000),
  /** ISO time to send at; omit to send on confirm */
  scheduled_for: z.iso.datetime({ offset: true }).nullable().optional(),
});

export const PublishAnnouncement = AnnouncementDraft.and(AudienceSpec).and(Confirmation);
export type PublishAnnouncement = z.infer<typeof PublishAnnouncement>;

// ── tickets ──────────────────────────────────────────────────────────────

export const TicketStatus = z.enum(["open", "acknowledged", "resolved", "cancelled"]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acknowledge"), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("assign"), assigned_to: z.uuid().nullable() }),
  z.object({ action: z.literal("note"), note: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal("cancel"), note: z.string().trim().min(1, "say why").max(500) }),
  /** resolving an out-of-commission ticket tells the same students "back in service" (T2) */
  z.object({
    action: z.literal("resolve"),
    note: z.string().trim().min(1, "say how").max(500),
    ...Confirmation.partial().shape,
  }),
]);
export type TicketAction = z.infer<typeof TicketAction>;

export const NewTicket = z.object({
  kind: z.enum(["breakdown", "route_change", "delay", "other"]),
  severity: Tier.default(2),
  bus_id: z.uuid().nullable().optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
});
export type NewTicket = z.infer<typeof NewTicket>;

// ── event-day CSV (SCHEMA §7) ────────────────────────────────────────────

export const Cohort = z.enum(["junior", "senior"]);
export type Cohort = z.infer<typeof Cohort>;

/** One validated line, before bus numbers and routes are checked against the database. */
export interface EventDayRow {
  /** 1-based spreadsheet line (header is line 1) */
  line: number;
  bus_number: string;
  route: string | null;
  direction: "inbound" | "outbound" | null;
  /** "HH:MM", 24-hour */
  departure_time: string | null;
  cohort: Cohort;
  notes: string | null;
}

const EVENT_DAY_HEADERS: Record<string, keyof Omit<EventDayRow, "line">> = {
  bus: "bus_number",
  bus_no: "bus_number",
  bus_number: "bus_number",
  bus_num: "bus_number",
  route: "route",
  route_name: "route",
  direction: "direction",
  departure: "departure_time",
  departure_time: "departure_time",
  departs: "departure_time",
  time: "departure_time",
  start_time: "departure_time",
  cohort: "cohort",
  group: "cohort",
  batch: "cohort",
  notes: "notes",
  note: "notes",
  remarks: "notes",
};

const canon = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** "7:40", "07:40", "7.40", "7:40 AM", "19:05" → "07:40" / "19:05"; undefined if unreadable. */
export function parseClock(raw: string): string | undefined {
  const m = /^(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?$/i.exec(raw.trim());
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toLowerCase()[0];
  if (min > 59) return undefined;
  if (ampm) {
    if (h < 1 || h > 12) return undefined;
    if (ampm === "p" && h !== 12) h += 12;
    if (ampm === "a" && h === 12) h = 0;
  } else if (h > 23) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "juniors", "Junior", "1st year" → junior; "both"/"all"/blank → both (null). */
function parseCohort(raw: string): Cohort | "both" | undefined {
  const v = raw.trim().toLowerCase();
  if (!v || v === "both" || v === "all") return "both";
  if (/^(junior|juniors|first[\s-]?years?|1st[\s-]?years?)$/.test(v)) return "junior";
  if (/^(senior|seniors)$/.test(v)) return "senior";
  return undefined;
}

/**
 * Parse an event-day bus list. Never throws on bad data: every problem is a per-line,
 * per-column error, so the preview can list all of them at once — and a file with any error
 * is rejected whole (nothing partial is ever applied or announced).
 *
 * `defaultCohort` fills blank cohort cells; "both" expands a line into a junior and a senior row.
 */
export function parseEventDayCsv(
  text: string,
  defaultCohort: Cohort | "both" = "both",
): { rows: EventDayRow[]; errors: CsvError[] } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => EVENT_DAY_HEADERS[canon(h)] ?? `?${h.trim()}`,
  });
  const headers = parsed.meta.fields ?? [];
  if (!headers.includes("bus_number")) {
    return {
      rows: [],
      errors: [{ row: 1, column: "bus_number", message: "column is missing from the header" }],
    };
  }
  const errors: CsvError[] = [];
  const rows: EventDayRow[] = [];
  const seen = new Map<string, number>();

  parsed.data.forEach((raw, i) => {
    const line = i + 2;
    const err = (column: string, message: string) => errors.push({ row: line, column, message });
    const busNumber = (raw.bus_number ?? "").trim().toUpperCase();
    if (!busNumber) err("bus_number", "is required");
    else if (!/^[A-Z0-9-]{1,12}$/.test(busNumber)) err("bus_number", "is not a bus number");

    const route = (raw.route ?? "").trim() || null;
    const dirRaw = (raw.direction ?? "").trim().toLowerCase();
    const direction =
      dirRaw === ""
        ? null
        : /^(in|inbound|to campus)$/.test(dirRaw)
          ? "inbound"
          : /^(out|outbound|from campus)$/.test(dirRaw)
            ? "outbound"
            : undefined;
    if (direction === undefined) err("direction", "must be inbound or outbound");

    const timeRaw = (raw.departure_time ?? "").trim();
    const departure = timeRaw ? parseClock(timeRaw) : null;
    if (departure === undefined) err("departure_time", `"${timeRaw}" is not a time like 7:40 AM`);

    const cohortRaw = (raw.cohort ?? "").trim();
    const cohort = cohortRaw ? parseCohort(cohortRaw) : defaultCohort;
    if (cohort === undefined) err("cohort", "must be junior, senior or both");

    const notes = (raw.notes ?? "").trim().slice(0, 200) || null;
    if (errors.some((e) => e.row === line)) return;

    for (const c of cohort === "both" ? (["junior", "senior"] as const) : [cohort!]) {
      const key = `${c}|${busNumber}`;
      const dup = seen.get(key);
      if (dup) {
        err("bus_number", `bus ${busNumber} is already listed for ${c}s on line ${dup}`);
        continue;
      }
      seen.set(key, line);
      rows.push({
        line,
        bus_number: busNumber,
        route,
        direction: direction ?? null,
        departure_time: departure ?? null,
        cohort: c,
        notes,
      });
    }
  });
  for (const e of parsed.errors)
    errors.push({ row: (e.row ?? 0) + 2, column: "?", message: e.message });
  if (!parsed.data.length && !errors.length)
    errors.push({ row: 2, column: "?", message: "the file has no bus lines" });
  errors.sort((x, y) => x.row - y.row);
  return { rows: errors.length ? [] : rows, errors };
}

/** POST /v1/admin/event-day/uploads query: which day, and the cohort blank cells mean. */
export const EventDayUploadParams = z.object({
  service_date: z.iso.date(),
  cohort: z.enum(["junior", "senior", "both"]).default("both"),
});
export type EventDayUploadParams = z.infer<typeof EventDayUploadParams>;
