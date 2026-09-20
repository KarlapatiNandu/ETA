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
- _(none yet — Stage 0 pending)_

### Decisions
- ADR-0001 — SSE over WebSocket and Supabase Realtime _(drafted in ARCHITECTURE section 2.2, to be formalised in Stage 3)_
- ADR-0002 — Redis as live fleet, Postgres as record _(drafted in ARCHITECTURE section 2.3)_

### Runbooks
- _(none yet)_

### Benchmarks
- _(none yet)_
