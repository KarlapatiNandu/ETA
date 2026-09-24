# Vault

The engineering log for Bus Mitra. Everything here exists to answer a question some future person will ask under pressure at 7:40 a.m.

`docs/` says how the system **is meant to work**. The vault says **what we actually did, what broke, and what we learned** — which is usually the more valuable of the two.

## Layout

| Folder | Holds | Written when |
|---|---|---|
| `modules/` | One entry per build stage: what shipped, files touched, schema changes, gotchas, how to verify, how to roll back | At the end of every stage, from `_TEMPLATE.md` |
| `decisions/` | ADRs — contested decisions with the options considered and the consequence accepted | Whenever a choice was genuinely close |
| `runbooks/` | Operational procedures for things that go wrong in production | When a failure mode is discovered, not after it bites |
| `benchmarks/` | Measured results: ETA accuracy, load tests, latency distributions | Whenever something is measured |

## Rules

1. **Write it at the end of the stage, not later.** The gotcha you remember vividly today is invisible in three weeks.
2. **Record the failures.** An entry that lists only what worked is marketing, not engineering. The dead end you spent a day in is the most valuable paragraph in the file.
3. **Record the rejected options in ADRs.** Six months from now someone will propose the thing you already rejected. Without the rejected options written down, you will re-litigate it from scratch.
4. **Runbooks are written for someone tired and worried,** not for someone reading carefully. Numbered steps, exact commands, expected output at each step.
5. **Never put credentials or student personal data in the vault.** It is committed to git like everything else.

## Naming

```
modules/M0{stage}-{slug}.md          e.g. M02-ingestion.md
decisions/ADR-{0000}-{slug}.md       e.g. ADR-0001-sse-over-websocket.md
runbooks/{symptom}.md                e.g. bus-not-appearing.md
benchmarks/{what}-{version}.md       e.g. eta-accuracy-v1.md
```

Runbooks are named after the **symptom** someone will search for, not the cause. Nobody greps for "consumer group lag" — they grep for "bus not appearing".

## Index

Kept current as stages complete.

### Modules
- [M00 — Foundations](modules/M00-foundations.md) _(in progress: build done; CI/people exits open)_
- [M04 — Identity and roster](modules/M04-identity.md) _(in progress: build done; real-SMS exit open)_
- [M01 — Geo core and route capture](modules/M01-geo-core.md) _(in progress: build done; one real route still to be surveyed)_
- [M02 — Ingestion pipeline](modules/M02-ingestion.md) _(in progress: build done; airplane test on a physical phone open)_
- [M03 — Live delivery](modules/M03-live-delivery.md) _(complete)_
- [M05 — Stops, search and personal ETA](modules/M05-search-eta.md) _(in progress: build done; stopwatch walk and the real-bus ETA soak open — the soak blocks Stage 6)_
- [M07 — Admin console](modules/M07-admin-console.md) _(in progress: build done and browser-tested; TD usability session open)_
- [M06 — Notification spine](modules/M06-notifications.md) _(in progress: built ahead of the Stage 5 gate; iPhone, phone latency, real SMS open)_

### Decisions
- [ADR-0001 — The live channel is SSE on the Fastify gateway](decisions/ADR-0001-sse-live-channel.md)
- ADR-0002 — Redis as live fleet, Postgres as record _(drafted in ARCHITECTURE section 2.3)_
- [ADR-0004 — Tiering and dedupe: exactly-once record, at-most-once transport](decisions/ADR-0004-tiering-and-dedupe.md)
- [ADR-0003 — Route versioning: immutable versions on a stable lineage](decisions/ADR-0003-route-versioning.md)
- [ADR-0006 — Uniform claim responses: decoy challenges](decisions/ADR-0006-uniform-claim-responses.md)
- [ADR-0007 — Confirmed sends and doorbells](decisions/ADR-0007-confirmed-sends-and-doorbells.md)

### Runbooks
- [Bus not appearing](runbooks/bus-not-appearing.md)
- [Student cannot claim their account](runbooks/student-cannot-claim.md)
- [Live map not updating](runbooks/live-map-not-updating.md)
- [CSV upload failed](runbooks/csv-upload-failed.md)
- [Push not delivering](runbooks/push-not-delivering.md)

### Benchmarks
- [Ingest soak — 30 simulated buses, one hour (v1)](benchmarks/ingest-1h-30-buses-v1.md)
- [ETA accuracy (v1) — simulated baseline; the real-bus soak is v2](benchmarks/eta-accuracy-v1.md)
- [Alert latency (v1) — event → push in a browser, and a 600-student T0](benchmarks/alert-latency-v1.md)
