import type { RosterRow } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";

/**
 * Roster import — the import half of engine/roster.ts (the event-day half is Stage 7).
 * Two-phase by construction (ARCH §10): `diffRoster` feeds the preview, `applyRoster` runs
 * only after an admin confirms it.
 *
 * Until BullMQ lands (it needs Redis, Stage 2) the gateway calls these in-process.
 */

type Field = "full_name" | "admission_year" | "phone_e164" | "branch";
const FIELDS: Field[] = ["full_name", "admission_year", "phone_e164", "branch"];

export interface ExistingRosterRow {
  roll_no: string;
  full_name: string;
  admission_year: number;
  phone_e164: string | null;
  branch: string | null;
  claimed: boolean;
}

export interface RosterChange {
  roll_no: string;
  claimed: boolean;
  fields: Partial<Record<Field, { from: unknown; to: unknown }>>;
}

export interface RosterDiff {
  added: RosterRow[];
  changed: RosterChange[];
  /** On the roster, missing from the file. Reported, never deleted — see applyRoster. */
  removed: { roll_no: string; claimed: boolean }[];
  unchanged: number;
  /** Rows (in the file, or already on the roster) that cannot be claimed without a phone. */
  missing_phone: number;
}

export interface DiffSummary {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  missing_phone: number;
}

export function summarise(diff: RosterDiff): DiffSummary {
  return {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged,
    missing_phone: diff.missing_phone,
  };
}

export function diffRoster(existing: ExistingRosterRow[], incoming: RosterRow[]): RosterDiff {
  const byRoll = new Map(existing.map((r) => [r.roll_no, r]));
  const seen = new Set<string>();
  const diff: RosterDiff = { added: [], changed: [], removed: [], unchanged: 0, missing_phone: 0 };

  for (const row of incoming) {
    seen.add(row.roll_no);
    const cur = byRoll.get(row.roll_no);
    if (!cur) {
      diff.added.push(row);
      if (!row.phone_e164) diff.missing_phone++;
      continue;
    }
    const fields: RosterChange["fields"] = {};
    for (const f of FIELDS) {
      const to = row[f] ?? null;
      const from = cur[f] ?? null;
      // A blank phone in the file never erases one already on the roster: the TD may have
      // filled it in through the work queue since the spreadsheet was exported.
      if (f === "phone_e164" && to === null) continue;
      if (to !== from) fields[f] = { from, to };
    }
    if (Object.keys(fields).length)
      diff.changed.push({ roll_no: row.roll_no, claimed: cur.claimed, fields });
    else diff.unchanged++;
    if (!(row.phone_e164 ?? cur.phone_e164) && !cur.claimed) diff.missing_phone++;
  }
  for (const cur of existing) {
    if (!seen.has(cur.roll_no)) diff.removed.push({ roll_no: cur.roll_no, claimed: cur.claimed });
  }
  return diff;
}

export async function loadRoster(q: Queryable): Promise<ExistingRosterRow[]> {
  const { rows } = await q.query<ExistingRosterRow>(
    `SELECT roll_no, full_name, admission_year, phone_e164, branch, claimed_at IS NOT NULL AS claimed
       FROM roster_students`,
  );
  return rows;
}

/**
 * Apply a confirmed diff. Run inside `withContext` so every row lands in audit_log with the
 * admin who confirmed it.
 *
 * Removals are NOT applied: deleting a roster row would orphan a claimed profile, and a row
 * missing from one export is more often a spreadsheet filter than a student who left.
 * Removal is an explicit admin action (Stage 7), not a side effect of an upload.
 *
 * A claimed student's profile keeps its verified phone even if the roster's changes —
 * the phone on the profile is the one proven by OTP.
 */
export async function applyRoster(q: Queryable, uploadId: string, diff: RosterDiff): Promise<void> {
  for (const r of diff.added) {
    await q.query(
      `INSERT INTO roster_students (roll_no, full_name, admission_year, cohort, phone_e164, branch, upload_id)
       VALUES ($1, $2, $3, derive_cohort($3::smallint, operating_date()), $4, $5, $6)`,
      [r.roll_no, r.full_name, r.admission_year, r.phone_e164 ?? null, r.branch ?? null, uploadId],
    );
  }
  for (const c of diff.changed) {
    const sets: string[] = [];
    const params: unknown[] = [c.roll_no, uploadId];
    for (const [f, v] of Object.entries(c.fields)) {
      params.push(v.to);
      sets.push(`${f} = $${params.length}`);
    }
    // SET expressions see the OLD row, so derive the cohort from the new year's parameter,
    // not from the admission_year column being assigned in the same statement.
    const yearParam = params.indexOf(c.fields.admission_year?.to, 2) + 1;
    if (c.fields.admission_year)
      sets.push(`cohort = derive_cohort($${yearParam}::smallint, operating_date())`);
    await q.query(
      `UPDATE roster_students SET ${sets.join(", ")}, upload_id = $2 WHERE roll_no = $1`,
      params,
    );
    if (c.fields.admission_year) {
      await q.query(
        `UPDATE profiles p SET cohort = r.cohort FROM roster_students r WHERE r.roll_no = $1 AND p.roll_no = r.roll_no`,
        [c.roll_no],
      );
    }
  }
}
