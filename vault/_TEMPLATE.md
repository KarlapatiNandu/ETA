---
stage: M0X
title: <Stage name>
status: complete | in-progress
started: YYYY-MM-DD
completed: YYYY-MM-DD
---

# M0X — <Stage name>

## Summary

Two or three sentences. What this stage makes possible that was not possible before.

## Scope delivered

- [ ] Item from the build plan
- [ ] Item from the build plan

**Deliberately not done, and why:** anything descoped, with the reason and where it moved to.

## Components added

| Path | What it is |
|---|---|
| `apps/…` | |
| `packages/…` | |

## Schema changes

| Migration | Change | Reversible? |
|---|---|---|
| `0004_add_x.sql` | | yes / no — why |

Include the exact rollback statement for anything not trivially reversible.

## Configuration

| Variable | Purpose | Where to obtain | Secret? |
|---|---|---|---|

## Technical decisions

For each non-obvious choice: what was chosen, what was rejected, and the consequence accepted. Promote anything genuinely contested to a full ADR in `decisions/` and link it.

## Gotchas and failure modes

**The most valuable section in this file.** Write every one down, including the ones that cost an afternoon and turned out to be trivial.

- **Symptom:** what you observe
  **Cause:** what is actually happening
  **Fix:** what to do
  **Prevention:** test added, guard added, or documented constraint

## Verifying locally

Exact commands, in order, with expected output. Written so that someone who has never run this stage can confirm it works.

```bash
pnpm dev
# then:
```

## Performance

Numbers measured, not estimated. State the conditions.

| Metric | Target | Measured | Conditions |
|---|---|---|---|

## Rolling back

How to undo this stage safely, including migrations and any data written.

## Carried forward

Known issues, TODOs and technical debt that the next stage inherits. Be specific enough to act on.
