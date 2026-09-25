import { inSpan, instruments, traceparentOf } from "@busmitra/telemetry";
import {
  BROADCAST_EVENTS,
  NotifyEvent,
  SseEvent,
  type BroadcastEvent,
  type UserFrames,
} from "@busmitra/contracts";
import type { Db, Queryable } from "@busmitra/db";
import {
  decide,
  dedupeKey,
  pushAccepted,
  pushGone,
  serviceDate,
  TIER,
  type AlertPrefs,
  type PushSender,
  type SmsSender,
  type Tier,
} from "@busmitra/notify";
import {
  ack,
  claimStale,
  ensureGroup,
  readGroup,
  STREAMS,
  type Keys,
  type Redis,
  type StreamEntry,
} from "@busmitra/redis";
import { audienceQuery } from "../lib/audience.ts";
import { planBroadcast, planNotify, type Plan } from "../lib/notify-plans.ts";

/**
 * engine/notify.ts — the notification spine (ARCHITECTURE §6.3, BUILD_PLAN Stage 6):
 *
 *   event → plan (tier, audience) → record → per-student filters → transport → receipt
 *
 * **Record** is one transaction: the parent `notifications` row (idempotent on `source_key`) and
 * every `notification_recipients` row (idempotent on `dedupe_key`). That is the notification
 * center, written before any transport is tried (invariant 14), and it is the whole of
 * exactly-once: a replayed event, a retried batch or a worker restarted mid-fan-out finds its
 * rows and adds nothing (invariant 5).
 *
 * **Deliver** claims due recipients with a compare-and-set on `sent_at IS NULL` and then tries
 * push, falling back to SMS for T0/T1 on the push POST's own HTTP status — synchronously, because
 * Web Push has no receipt to wait for. A claimed row is never claimed again, so a transport is
 * attempted at most once per student: a crash between the claim and the send can cost one buzz
 * (the center still has it); it can never cost two.
 *
 * **Recover** (ADR-0007): rows published but never delivered because a doorbell was lost.
 */

export const NOTIFY = {
  DELIVER_EVERY_MS: 1_000,
  RECOVER_EVERY_MS: 30_000,
  /** a published source with no notification after this long had its doorbell lost */
  RECOVER_AFTER_S: 30,
  RECOVER_WINDOW_H: 24,
  /** recipients claimed per delivery pass */
  BATCH: 1_000,
  /** concurrent transport calls */
  CONCURRENCY: 64,
  UNHEALTHY_AT: 5,
  /** a claimed row still unfinished after this long belonged to a sender that died */
  INTERRUPTED_AFTER_S: 120,
  BACKOFF_429_S: 60,
} as const;

export interface NotifyDeps {
  db: Db;
  redis: Redis;
  keys: Keys;
  /** null when VAPID is not configured: every recipient is treated as having no subscription */
  push: PushSender | null;
  sms: SmsSender;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface PrefRow extends AlertPrefs {
  user_id: string;
}

// ── record ────────────────────────────────────────────────────────────────

/**
 * Write the parent and every recipient row in one transaction. Returns the notification id and
 * the students newly added (empty when the event had already been recorded).
 */
export async function record(
  deps: Pick<NotifyDeps, "db" | "redis" | "keys" | "now" | "log">,
  plan: Plan,
): Promise<{ id: string; recipients: string[] }> {
  const now = (deps.now ?? Date.now)();
  const stale = plan.freshForS !== null && now - plan.eventAt >= plan.freshForS * 1000;
  const expired = plan.expiresAt !== null && plan.expiresAt.getTime() <= now;
  const day = serviceDate(plan.eventAt);

  const out = await deps.db.tx(async (q) => {
    const parent = await q.query<{ id: string }>(
      `INSERT INTO notifications (source_key, tier, category, title, body, payload, collapse_tag,
                                  bus_id, trip_id, ticket_id, created_by, expires_at)
       VALUES ($1, $2, $3::notif_category_t, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (source_key) DO NOTHING RETURNING id`,
      [
        plan.sourceKey,
        plan.tier,
        plan.category,
        plan.title,
        plan.body,
        JSON.stringify({ ...plan.payload, url: plan.url, actions: plan.actions ?? [] }),
        plan.collapseTag,
        plan.busId,
        plan.tripId,
        plan.ticketId,
        plan.createdBy,
        plan.expiresAt?.toISOString() ?? null,
      ],
    );
    if (!parent.rows[0]) {
      // already recorded — by an earlier delivery of this event, or a replay
      const found = await q.query<{ id: string }>(
        `SELECT id FROM notifications WHERE source_key = $1`,
        [plan.sourceKey],
      );
      return { id: found.rows[0]!.id, recipients: [] as string[] };
    }
    const id = parent.rows[0].id;

    const aq = audienceQuery(plan.audience);
    const busParam = aq.params.length + 1;
    const { rows: people } = await q.query<PrefRow>(
      `SELECT p.id AS user_id, p.alerts_paused_until, p.max_tier, p.critical_breakthrough,
              p.quiet_start_min, p.quiet_duration_min, f.muted_until AS bus_muted_until
         FROM (SELECT DISTINCT user_id FROM (${aq.sql}) a) a
         JOIN profiles p ON p.id = a.user_id
         LEFT JOIN favourites f ON f.user_id = p.id AND f.bus_id = $${busParam}::uuid`,
      [...aq.params, plan.busId],
    );
    if (!people.length) return { id, recipients: [] as string[] };

    const users: string[] = [];
    const keys: string[] = [];
    const channels: string[] = [];
    const after: string[] = [];
    const sent: string[] = [];
    const reasons: string[] = [];
    const nowIso = new Date(now).toISOString();
    for (const p of people) {
      const d: ReturnType<typeof decide> = stale
        ? { kind: "suppress", reason: "tier_4" }
        : decide(plan.tier, p, now);
      users.push(p.user_id);
      keys.push(
        dedupeKey({
          userId: p.user_id,
          eventType: plan.category,
          busId: plan.busId,
          stopId: plan.stopId,
          serviceDate: day,
          content: plan.sourceKey,
        }),
      );
      if (stale || expired || d.kind === "suppress") {
        // center only: the transport is decided now, and it is "none"
        channels.push("inapp_only");
        after.push(nowIso);
        sent.push(nowIso);
        reasons.push(stale ? "late" : expired ? "expired" : (d as { reason: string }).reason);
      } else {
        channels.push("");
        after.push(d.kind === "defer" ? d.until.toISOString() : nowIso);
        sent.push("");
        reasons.push(d.kind === "defer" ? "quiet_hours" : "");
      }
    }
    // text[] and casts in SQL: PGlite cannot serialise uuid[]/timestamptz[] parameters
    const ins = await q.query<{ user_id: string }>(
      `INSERT INTO notification_recipients
         (notification_id, user_id, dedupe_key, channel, deliver_after, sent_at, failure_reason)
       SELECT $1, u::uuid, k, NULLIF(c, '')::notif_channel_t, d::timestamptz,
              NULLIF(s, '')::timestamptz, NULLIF(r, '')
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS x(u, k, c, d, s, r)
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [id, users, keys, channels, after, sent, reasons],
    );
    if (plan.announcementId) {
      await q.query(
        `UPDATE announcements SET notification_id = $2 WHERE id = $1 AND notification_id IS NULL`,
        [plan.announcementId, id],
      );
    }
    return { id, recipients: ins.rows.map((r) => r.user_id) };
  });

  // live frames for open apps — best effort; the center is the record either way
  if (out.recipients.length) {
    const frames: UserFrames[] = [
      {
        userIds: out.recipients,
        frame: {
          type: "notification",
          data: {
            id: out.id,
            tier: plan.tier,
            title: plan.title,
            body: plan.body,
            createdAt: new Date(now).toISOString(),
          },
        },
      },
    ];
    if (plan.ticketId && plan.ticketStatus) {
      frames.push({
        userIds: out.recipients,
        frame: {
          type: "ticket.update",
          data: { id: plan.ticketId, status: plan.ticketStatus, at: new Date(now).toISOString() },
        },
      });
    }
    for (const f of frames)
      await deps.redis
        .publish(deps.keys.notifyChannel, JSON.stringify(f))
        .catch((err) => deps.log?.("notify: live frame failed", { error: (err as Error).message }));
  }
  return out;
}

// ── tracing (Stage 8) ─────────────────────────────────────────────────────

/**
 * The trace a notification continues, from the event that caused it to its delivery pass. Kept
 * in process memory and bounded: a trace that ends at "recorded" after an engine restart is an
 * acceptable loss; a column for it is not worth a migration.
 */
const traceOfNotification = new Map<string, string>();
function rememberTrace(notificationId: string) {
  const tp = traceparentOf();
  if (!tp) return;
  traceOfNotification.set(notificationId, tp);
  if (traceOfNotification.size > 10_000) {
    traceOfNotification.delete(traceOfNotification.keys().next().value!);
  }
}

/** record() inside a span that continues the stream entry's trace, when it carries one. */
async function recordTraced(
  deps: Pick<NotifyDeps, "db" | "redis" | "keys" | "now" | "log">,
  plan: Plan,
  tp: string | undefined,
): Promise<{ id: string; recipients: string[] }> {
  if (!tp) return record(deps, plan);
  return inSpan(
    "notify.record",
    { parent: tp, attributes: { "busmitra.source": plan.sourceKey, "busmitra.tier": plan.tier } },
    async (span) => {
      const r = await record(deps, plan);
      span.setAttribute("busmitra.recipients", r.recipients.length);
      if (r.recipients.length) rememberTrace(r.id);
      return r;
    },
  );
}

// ── deliver ───────────────────────────────────────────────────────────────

interface DueRow {
  notification_id: string;
  user_id: string;
  tier: Tier;
  title: string;
  body: string;
  collapse_tag: string | null;
  payload: { url?: string; actions?: { action: string; title: string }[] };
  expires_at: Date | null;
  phone_e164: string | null;
  created_at: Date;
}

interface SubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface DeliverReport {
  claimed: number;
  pushed: number;
  texted: number;
  inAppOnly: number;
}

/**
 * One delivery pass: claim what is due, send it, write down what happened. Each recipient row is
 * claimed exactly once (the UPDATE … WHERE sent_at IS NULL is the gate), so two workers or a
 * restarted one never double-send.
 */
export async function deliverDue(deps: NotifyDeps): Promise<DeliverReport> {
  const now = (deps.now ?? Date.now)();
  const nowIso = new Date(now).toISOString();
  const report: DeliverReport = { claimed: 0, pushed: 0, texted: 0, inAppOnly: 0 };
  let budget: number = NOTIFY.BATCH;

  /**
   * Claim ONE due recipient, with that student's healthy subscriptions. Each of CONCURRENCY
   * senders claims its next row only when it is free, so a crash can cost at most the rows in
   * flight — never a whole batch claimed up front and not yet sent (Stage 8 chaos drill: the
   * old claim-1,000-then-send loop lost 540 of 600 buzzes to one SIGKILL). And no sender waits
   * for another's slow push service.
   */
  const claimOne = async (): Promise<(DueRow & { subs: SubRow[] | null }) | null> => {
    if (budget <= 0) return null;
    budget--;
    const { rows } = await deps.db.query<DueRow & { subs: SubRow[] | null }>(
      `WITH due AS (
         SELECT notification_id, user_id FROM notification_recipients
          WHERE sent_at IS NULL AND deliver_after <= $1::timestamptz
          ORDER BY deliver_after
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE notification_recipients r SET sent_at = $1::timestamptz
           FROM due WHERE r.notification_id = due.notification_id AND r.user_id = due.user_id
             AND r.sent_at IS NULL
         RETURNING r.notification_id, r.user_id
       )
       SELECT c.notification_id, c.user_id, n.tier, n.title, n.body, n.collapse_tag, n.payload,
              n.expires_at, p.phone_e164, n.created_at,
              (SELECT json_agg(json_build_object('id', s.id, 'user_id', s.user_id,
                        'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                 FROM push_subscriptions s
                WHERE s.user_id = c.user_id AND s.failure_count < $2
                  AND (s.backoff_until IS NULL OR s.backoff_until <= $1::timestamptz)) AS subs
         FROM claimed c JOIN notifications n ON n.id = c.notification_id
         JOIN profiles p ON p.id = c.user_id`,
      [nowIso, NOTIFY.UNHEALTHY_AT],
    );
    if (!rows[0]) {
      budget = 0; // nothing due: every sender stops
      return null;
    }
    report.claimed++;
    return rows[0];
  };

  const sender = async () => {
    for (let r = await claimOne(); r; r = await claimOne()) {
      const row = r;
      const tp = traceOfNotification.get(row.notification_id);
      await (tp
        ? inSpan("notify.deliver", { parent: tp, attributes: { "busmitra.tier": row.tier } }, () =>
            deliverOne(row, row.subs ?? []),
          )
        : deliverOne(row, row.subs ?? []));
    }
  };
  await Promise.all(Array.from({ length: NOTIFY.CONCURRENCY }, sender));
  return report;

  async function deliverOne(r: DueRow, subs: SubRow[]): Promise<void> {
    const behaviour = TIER[r.tier];
    const accepted = () =>
      instruments
        .notifyLatency()
        .record(Math.max(0, (Date.now() - new Date(r.created_at).getTime()) / 1000), {
          tier: r.tier,
        });
    const notes: string[] = [];
    if (r.expires_at && new Date(r.expires_at).getTime() <= now) {
      await finish(deps.db, r, "inapp_only", null, "expired", null);
      report.inAppOnly++;
      return;
    }
    let pushed = false;
    const mine = deps.push ? subs : [];
    if (!mine.length) notes.push(deps.push ? "no push subscription" : "push not configured");
    for (const s of mine) {
      const sentAt = Date.now();
      const res = await deps.push!.send(
        s,
        {
          title: r.title,
          body: r.body,
          tag: r.collapse_tag,
          renotify: r.tier <= 1,
          requireInteraction: behaviour.requireInteraction,
          data: {
            notificationId: r.notification_id,
            url: r.payload.url ?? "/notifications",
            tier: r.tier,
          },
          ...(r.payload.actions?.length ? { actions: r.payload.actions } : {}),
        },
        {
          urgency: behaviour.urgency,
          ttlS: behaviour.ttlS,
          ...(r.collapse_tag ? { topic: r.collapse_tag } : {}),
        },
      );
      // alert-latency v2 (M06 carried forward): how long the push service took to answer
      instruments.pushPost().record(Date.now() - sentAt, { status: String(res.status) });
      instruments.notifySends().add(1, {
        channel: "push",
        tier: r.tier,
        outcome: pushAccepted(res.status) ? "accepted" : pushGone(res.status) ? "gone" : "failed",
      });
      if (pushAccepted(res.status)) {
        if (!pushed) accepted();
        pushed = true;
        await deps.db.query(
          `UPDATE push_subscriptions SET failure_count = 0, last_success_at = $2, backoff_until = NULL WHERE id = $1`,
          [s.id, nowIso],
        );
      } else if (pushGone(res.status)) {
        // the browser revoked it or the user uninstalled: gone for good (ARCH §6.3)
        await deps.db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
        notes.push(`push ${res.status}: subscription removed`);
      } else if (res.status === 429) {
        await deps.db.query(`UPDATE push_subscriptions SET backoff_until = $2 WHERE id = $1`, [
          s.id,
          new Date(now + NOTIFY.BACKOFF_429_S * 1000).toISOString(),
        ]);
        notes.push("push 429: backing off");
      } else {
        await deps.db.query(
          `UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1`,
          [s.id],
        );
        notes.push(`push ${res.status || "network error"}`);
      }
    }

    // SMS: T0 always; T1 when push could not carry it — decided on the POST's status, now
    let texted = false;
    let ref: string | null = null;
    if (behaviour.sms === "always" || (behaviour.sms === "fallback" && !pushed)) {
      if (r.phone_e164) {
        try {
          const res = await deps.sms.send({
            to: r.phone_e164,
            template: r.tier === 0 ? "t0_alert" : "t1_alert",
            vars: { title: r.title.slice(0, 60), body: r.body.slice(0, 100) },
          });
          texted = true;
          ref = (res && res.ref) || null;
          instruments.notifySends().add(1, { channel: "sms", tier: r.tier, outcome: "accepted" });
          if (!pushed) accepted();
        } catch (err) {
          notes.push(`sms: ${(err as Error).message.slice(0, 120)}`);
          instruments.notifySends().add(1, { channel: "sms", tier: r.tier, outcome: "failed" });
        }
      } else notes.push("no phone");
    }
    const channel = pushed ? "push" : texted ? "sms" : "inapp_only";
    if (pushed) report.pushed++;
    if (texted) report.texted++;
    if (!pushed && !texted) report.inAppOnly++;
    await finish(deps.db, r, channel, pushed ? nowIso : null, notes.join("; ") || null, ref);
  }
}

function finish(
  db: Queryable,
  r: Pick<DueRow, "notification_id" | "user_id">,
  channel: "push" | "sms" | "inapp_only",
  deliveredAt: string | null,
  reason: string | null,
  ref: string | null,
) {
  return db.query(
    `UPDATE notification_recipients
        SET channel = $3::notif_channel_t, delivered_at = $4::timestamptz, failure_reason = $5, provider_ref = $6
      WHERE notification_id = $1 AND user_id = $2`,
    [r.notification_id, r.user_id, channel, deliveredAt, reason, ref],
  );
}

// ── recover lost doorbells (ADR-0007) ────────────────────────────────────

/**
 * Sources that were published but never became a notification: the doorbell was lost between
 * the commit and the XADD. Re-planning them is safe — `source_key` makes it idempotent.
 */
/**
 * Rows a sender claimed but never finished: the engine died mid-send (Stage 8 chaos drill —
 * SIGKILL mid-fan-out left 64 such rows, one per sender in flight). At-most-once means they are
 * never sent again (ADR-0004), but they must not stay "undecided" for ever: the admin's delivery
 * counts and the dashboards would be wrong. They are marked interrupted — honestly: the push may
 * well have gone (in the drill, all 64 had reached the push service).
 */
export async function closeInterrupted(db: Queryable, now: number): Promise<number> {
  const r = await db.query(
    `UPDATE notification_recipients
        SET failure_reason = 'interrupted: the engine stopped mid-send (the push may have been delivered)'
      WHERE channel IS NULL AND failure_reason IS NULL AND sent_at IS NOT NULL
        AND sent_at < $1::timestamptz - make_interval(secs => $2)
      RETURNING 1`,
    [new Date(now).toISOString(), NOTIFY.INTERRUPTED_AFTER_S],
  );
  return r.rows.length;
}

export async function recoverLost(
  deps: Pick<NotifyDeps, "db" | "redis" | "keys" | "now" | "log">,
): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const q = deps.db;
  const since = new Date(now - NOTIFY.RECOVER_WINDOW_H * 3600_000).toISOString();
  const until = new Date(now - NOTIFY.RECOVER_AFTER_S * 1000).toISOString();
  const at = new Date(now).toISOString();
  const events: NotifyEvent[] = [];

  const ann = await q.query<{ id: string }>(
    `SELECT id FROM announcements
      WHERE published_at BETWEEN $1::timestamptz AND $2::timestamptz
        AND cancelled_at IS NULL AND notification_id IS NULL`,
    [since, until],
  );
  for (const r of ann.rows) events.push({ type: "announcement", announcementId: r.id, at });

  const tick = await q.query<{ id: string; transition: "opened" | "resolved" }>(
    `SELECT k.id, x.transition FROM tickets k,
            LATERAL (VALUES ('opened', k.opened_at), ('resolved', k.resolved_at)) AS x(transition, t)
      WHERE k.kind = 'out_of_commission' AND x.t BETWEEN $1::timestamptz AND $2::timestamptz
        AND (x.transition = 'opened' OR k.status = 'resolved')
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.source_key = 'ticket:' || k.id || ':' || x.transition)`,
    [since, until],
  );
  for (const r of tick.rows)
    events.push({ type: "ticket", ticketId: r.id, transition: r.transition, at });

  const ed = await q.query<{ id: string }>(
    `SELECT u.id FROM roster_uploads u
      WHERE u.kind = 'event_day_buses' AND u.status = 'applied'
        AND u.applied_at BETWEEN $1::timestamptz AND $2::timestamptz
        AND jsonb_array_length(COALESCE(u.diff_summary->'notify_cohorts', '[]'::jsonb)) > 0
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.source_key = 'event_day:' || u.id)`,
    [since, until],
  );
  for (const r of ed.rows) events.push({ type: "event_day", uploadId: r.id, at });

  // leave-now fired (the database decided) but its event never arrived: recorded late, it is
  // center-only by the freshness rule — the honest outcome for an alert that is now old
  const ln = await q.query<{
    id: string;
    user_id: string;
    trip_id: string;
    bus_id: string;
    target_stop_id: string;
    travel_time_s: number | null;
    buffer_s: number;
    notified_departure_at: Date;
  }>(
    `SELECT s.id, s.user_id, s.trip_id, t.bus_id, s.target_stop_id, s.travel_time_s, s.buffer_s,
            s.notified_departure_at
       FROM trip_subscriptions s JOIN trips t ON t.id = s.trip_id
      WHERE s.notified_departure_at BETWEEN $1::timestamptz AND $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM notifications n
                         WHERE n.source_key = 'leave_now:' || s.id || ':' || s.target_stop_id)`,
    [since, until],
  );
  for (const r of ln.rows)
    events.push({
      type: "leave_now",
      subscriptionId: r.id,
      userId: r.user_id,
      tripId: r.trip_id,
      busId: r.bus_id,
      stopId: r.target_stop_id,
      etaP50S: 0,
      etaP90S: 0,
      travelTimeS: r.travel_time_s ?? 0,
      bufferS: r.buffer_s,
      at: new Date(r.notified_departure_at).toISOString(),
    });

  for (const e of events) {
    for (const plan of await planNotify(q, e)) await record(deps, plan);
  }
  if (events.length) deps.log?.("notify: recovered lost doorbells", { count: events.length });
  return events.length;
}

// ── consumers ─────────────────────────────────────────────────────────────

/** Plan and record one batch from `stream:notify`. */
export async function processNotifyEntries(
  deps: Pick<NotifyDeps, "db" | "redis" | "keys" | "now" | "log">,
  entries: StreamEntry<unknown>[],
): Promise<number> {
  let recorded = 0;
  for (const entry of entries) {
    const parsed = NotifyEvent.safeParse(entry.data);
    if (!parsed.success) {
      deps.log?.("notify: dropped an unreadable event", { id: entry.id });
      continue;
    }
    for (const plan of await planNotify(deps.db, parsed.data)) {
      recorded += (await recordTraced(deps, plan, entry.tp)).recipients.length;
    }
  }
  return recorded;
}

/** Plan and record one batch from `stream:events` (stop progress, signal lost/restored). */
export async function processBroadcastEntries(
  deps: Pick<NotifyDeps, "db" | "redis" | "keys" | "now" | "log">,
  entries: StreamEntry<unknown>[],
): Promise<number> {
  const now = (deps.now ?? Date.now)();
  let recorded = 0;
  for (const entry of entries) {
    const parsed = SseEvent.safeParse(entry.data);
    if (!parsed.success || !(BROADCAST_EVENTS as readonly string[]).includes(parsed.data.type))
      continue;
    for (const plan of await planBroadcast(deps.db, parsed.data as BroadcastEvent, now)) {
      recorded += (await recordTraced(deps, plan, entry.tp)).recipients.length;
    }
  }
  return recorded;
}

async function consume(
  deps: NotifyDeps & { stream: Redis; consumer: string; signal: AbortSignal },
  streamKey: string,
  handle: (entries: StreamEntry<unknown>[]) => Promise<number>,
  wake: () => void,
) {
  const opts = { stream: streamKey, group: STREAMS.GROUP_NOTIFY, consumer: deps.consumer };
  await ensureGroup(deps.redis, streamKey, STREAMS.GROUP_NOTIFY);
  let recovering = true;
  let lastClaim = 0;
  while (!deps.signal.aborted) {
    try {
      let batch: StreamEntry<unknown>[];
      if (recovering) {
        batch = await readGroup(deps.stream, { ...opts, count: 100, pending: true });
        if (batch.length === 0) recovering = false;
      } else if (Date.now() - lastClaim > 30_000) {
        lastClaim = Date.now();
        batch = await claimStale(deps.stream, { ...opts, minIdleMs: 30_000, count: 100 });
      } else {
        batch = await readGroup(deps.stream, { ...opts, count: 100, blockMs: 1000 });
      }
      if (!batch.length) continue;
      const n = await handle(batch);
      // acknowledged only once recorded: a crash before this re-reads the batch, and the
      // database makes the second pass a no-op
      await ack(
        deps.redis,
        streamKey,
        STREAMS.GROUP_NOTIFY,
        batch.map((e) => e.id),
      );
      if (n) wake();
    } catch (err) {
      if (deps.signal.aborted) break;
      deps.log?.("notify: batch failed, retrying", {
        stream: streamKey,
        error: (err as Error).message,
      });
      recovering = true;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/**
 * The notify worker: two consumers (`stream:notify`, `stream:events`) that record, one delivery
 * loop that sends — woken at once when something was recorded, and every second regardless
 * (quiet-hours deferrals come due on the clock) — and the lost-doorbell sweep.
 */
export async function runNotify(
  deps: NotifyDeps & {
    notifyStream: Redis;
    eventsStream: Redis;
    consumer: string;
    signal: AbortSignal;
  },
): Promise<void> {
  let wakeUp: (() => void) | null = null;
  const wake = () => wakeUp?.();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wakeUp = null;
        resolve();
      }
      wakeUp = done;
      deps.signal.addEventListener("abort", done, { once: true });
    });

  const deliverLoop = async () => {
    let lastRecover = 0;
    while (!deps.signal.aborted) {
      try {
        if (Date.now() - lastRecover > NOTIFY.RECOVER_EVERY_MS) {
          lastRecover = Date.now();
          await recoverLost(deps);
          const n = await closeInterrupted(deps.db, (deps.now ?? Date.now)());
          if (n) deps.log?.("notify: marked sends interrupted by a crash", { count: n });
        }
        let r: DeliverReport;
        do {
          r = await deliverDue(deps);
          if (r.claimed) deps.log?.("notify: delivered", { ...r });
        } while (r.claimed === NOTIFY.BATCH && !deps.signal.aborted);
      } catch (err) {
        if (deps.signal.aborted) break;
        deps.log?.("notify: delivery pass failed", { error: (err as Error).message });
      }
      await sleep(NOTIFY.DELIVER_EVERY_MS);
    }
  };

  await Promise.all([
    consume(
      { ...deps, stream: deps.notifyStream },
      deps.keys.streamNotify,
      (b) => processNotifyEntries(deps, b),
      wake,
    ),
    consume(
      { ...deps, stream: deps.eventsStream },
      deps.keys.streamEvents,
      (b) => processBroadcastEntries(deps, b),
      wake,
    ),
    deliverLoop(),
  ]);
}
