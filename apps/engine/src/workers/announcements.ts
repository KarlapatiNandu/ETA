import type { NotifyEvent } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import { ringNotify, type Keys, type Redis } from "@busmitra/redis";

/**
 * Scheduled announcements (BUILD_PLAN Stage 7 "schedule-for-later"). An announcement confirmed
 * for a later time waits in `announcements_due`; this pass publishes the ones whose time has
 * come and rings `stream:notify` for each.
 *
 * Publishing is a compare-and-set on `published_at IS NULL` (invariant 5), so two engines, or a
 * pass that races an admin's cancel, publish each announcement at most once. The doorbell is
 * rung after the commit; if Redis drops it, the notify worker's sweep over published
 * announcements that have no notification yet (Stage 6) delivers it anyway.
 */

export const DISPATCH_EVERY_MS = 15_000;

export async function dispatchDueAnnouncements(deps: {
  db: Queryable;
  redis: Redis;
  keys: Keys;
  now?: () => number;
}): Promise<string[]> {
  const now = new Date((deps.now ?? Date.now)()).toISOString();
  const { rows } = await deps.db.query<{ id: string }>(
    `UPDATE announcements SET published_at = $1::timestamptz
      WHERE published_at IS NULL AND cancelled_at IS NULL AND scheduled_for <= $1::timestamptz
      RETURNING id`,
    [now],
  );
  const events: NotifyEvent[] = rows.map((r) => ({
    type: "announcement",
    announcementId: r.id,
    at: now,
  }));
  await ringNotify(deps.redis, deps.keys, events);
  return rows.map((r) => r.id);
}
