# Runbook — alerts stopped arriving, or arrived late (the engine or a worker died)

**Symptom:** students say alerts stopped or came late; the alert *A stream consumer is falling
behind* fires; `/admin/health` shows a growing backlog on `stream:notify/notify` or
`stream:events/…`; or the admin's announcement list shows recipients stuck with no channel.

For "one student did not get one alert", start at [push-not-delivering.md](push-not-delivering.md)
instead — this runbook is for *everyone*.

**What the system does by itself (measured, chaos drill 2026-09-24):** a T0 to 300 students; the
engine was **SIGKILLed after 49 pushes** and restarted 2 s later. Result: **300/300 pushes
delivered, 0 duplicates**, last push 5.5 s after the send, every student's notification-center
row present. Why: the record is exactly-once in the database (`notif_dedupe`, `source_key`);
each of the 64 senders claims one row at a time (`sent_at`), so at most 64 rows were in flight
when the process died. Those 64 are never sent twice (ADR-0004: at-most-once transport) — in the
drill their pushes had already reached the push service. Two minutes later the restarted worker
marks such rows `interrupted` so the counts stay honest.

⚠️ Before Stage 8 the worker claimed up to **1,000 rows at once** and then sent them 64 at a
time; the same SIGKILL would have left ~250 of 300 students without the buzz.

## Do

1. `/admin/health` → which stream is behind?
   - `stream:notify/notify` or `stream:events/notify` → the notify worker.
   - `stream:events/eta` → ETAs are stale (leave-now waits on them).
   - `stream:pings/geo` → the live map itself is stale: treat as
     [live-map-not-updating.md](live-map-not-updating.md).
2. Is the engine running? `fly status -a busmitra-engine` (local: `pgrep -f engine`). Its log
   should show `notify: delivered` lines during a send.
3. Dead or wedged → restart it (`fly machine restart …`). It first re-reads its own unacknowledged
   entries, then claims what dead consumers left (30 s idle), then new entries. Nothing is lost
   and nothing is sent twice. Lag should return to 0 within a minute.
4. **Never start a second engine** to "help": two engines split the geo consumer group.
5. Afterwards, rows marked `interrupted: the engine stopped mid-send` are the students who may
   have missed that one buzz; the entry is in their notification center regardless.

## Rehearse

`pnpm sim chaos worker` (stop `pnpm dev` first).
