# Read this first

> **Every Claude Code run on this repository starts here.** Read this file, then `tracker.md`, before touching anything else. It is short on purpose. It exists so that a fresh session with no memory of the last one behaves like the same engineer who left off yesterday.

---

## 1. The first five minutes of every run

Do these in order, before writing a single line of code or answering a design question:

1. **Read `tracker.md`** — the single source of truth for *where the project currently is*: which stages are complete, which is in progress, which exit criteria are still open, and which external dependencies are outstanding.
2. **Read `docs/ARCHITECTURE.md`** — the technical design. Every decision has a stated reason; the reasons matter more than the conclusions.
3. **Read `docs/BUILD_PLAN.md`** — the ten stages, their dependency order, their exit criteria, and the per-stage ritual.
4. **Read `docs/SCHEMA.md`** — the data model. Migrations in `packages/db/migrations` must match it.
5. **Read the vault entry for the most recently completed stage** (`vault/modules/M0X-*.md`) — especially its **Gotchas** and **Carried forward** sections. That is where the last run left landmines and unfinished work.
6. **Check `git log --oneline -15`** and the working tree, so you do not repeat work that is already committed.

If the task is a question rather than a build task, steps 1–4 still apply. Answering an architecture question without reading the architecture is how this project accumulates contradictions.

---

## 2. Build order — non-negotiable

Stage numbers are **identities, not an order**. They are referenced by vault filenames, ADRs and runbooks, so they never change. The build order is:

```
0 → 4 → 1 → 2 → 3 → 5 / 7 → 6 → 8 → 9
```

with the pure-maths half of Stage 1 (`packages/geo`, the simulator, the trace→route pipeline) running alongside Stage 4.

- **Stage 4 comes before Stages 1–3** because the admin route editor (Stage 1) and the SSE stream (Stage 3) are both authenticated, role-gated, per-user surfaces. Building them against a stubbed identity means building them twice.
- **Do not start Stage 6 before Stage 5's ETA MAE gate is met.** A notification spine built on an unmeasured ETA is a machine for lying to students at 7:40 a.m.
- Stages 5 and 8 have **soak gates** that need real buses and real elapsed time. Those are tracked separately in `tracker.md` and may complete during a later stage. A soak gate does not license skipping the build work.

---

## 3. Invariants — violating any of these is a bug, not a trade-off

These are the load-bearing decisions from `docs/ARCHITECTURE.md`. If a change would break one, stop and raise it rather than working around it.

| # | Invariant | Source |
|---|---|---|
| 1 | **Postgres is never on the read path for live data.** Redis is the live fleet; Postgres is the system of record. Persistence lags on a separate consumer nobody waits on. | ARCH §1, ADR-0002 |
| 2 | **The app never fabricates a position or an ETA.** Every degraded state has a designed, honest presentation with an explicit timestamp. | ARCH §11 |
| 3 | **Presence thresholds are multiples of the tracker's reported `cadence_s`** (3× DEGRADED, 9× DARK), never absolute seconds. A parked bus must stay green. | ARCH §5.7 |
| 4 | **Backfilled pings never fire notifications retroactively** and never overwrite a newer `fleet:live` entry. | ARCH §5.7 |
| 5 | **Idempotency is enforced in the database, not in application logic** — `notification_recipients.dedupe_key`, `trip_stop_events (trip_id, seq, event)`, `positions (trip_id, recorded_at)`. | ARCH §6.2, SCHEMA §4/§6 |
| 6 | **Tracker secrets are encrypted (`pgp_sym_encrypt`), never hashed.** HMAC verification needs the plaintext. | ARCH §10, SCHEMA §2 |
| 7 | **Operational data keys on `routes.id`; learned data keys on `routes.lineage_id`.** A re-survey must not reset the traffic model or the dead zones. | ARCH §5.1, SCHEMA §3 |
| 8 | **SSE lives on the Fastify gateway, never on a Next.js API route.** Serverless execution caps sever the stream. | ADR-0001 |
| 9 | **Only broadcast-class events carry resumable ids.** Per-user frames are re-derived on connect, never replayed, or one student receives another's payload. | ARCH §7 |
| 10 | **The SSE connection cap uses per-connection TTL keys, not a SET.** A SET cannot forget a crashed gateway's connections and locks the user out permanently. | ARCH §7, SCHEMA §10 |
| 11 | **Nothing reaches student phones without a rendered preview, a resolved recipient count and an explicit confirmation.** No CSV ever auto-publishes. | ARCH §10, Stage 7 |
| 12 | **RLS on every table, deny by default.** Service-role paths bypass it, so their authorisation logic must be unit-tested. | SCHEMA §9 |
| 13 | **`packages/geo` is pure**: no I/O, no clock reads, every input explicit, so it can be replayed against recorded traces. | Stage 1 |
| 14 | **The notification center is written unconditionally**, regardless of push or SMS success. | ARCH §6.3 |
| 15 | **Redis keys are constructed only through `packages/redis/keys.ts`.** Never inline a key string. | SCHEMA §10 |

---

## 4. Working rules for a run

**Before building anything:**

- Confirm from `tracker.md` which stage you are in, and that its prerequisites are genuinely complete — not "mostly".
- Re-read that stage's **Build**, **Components** and **Exit criteria** sections in `docs/BUILD_PLAN.md`.
- Work only inside the current stage's scope. If you find something belonging to a later stage, write it into that stage's carried-forward notes in `tracker.md` instead of building it.

**While building:**

- Follow the folder structure in `docs/BUILD_PLAN.md`. Do not invent new top-level directories.
- Contracts first: anything crossing an app boundary gets a Zod schema in `packages/contracts` before either side is written.
- If a schema change is needed, update `docs/SCHEMA.md` **in the same change** as the migration. If they diverge, the document wins and the migration is wrong.
- When reality contradicts a document, **update the document** — do not silently build the other thing. A doc that quietly disagrees with the code is worse than no doc.

**Before declaring a stage complete:**

- Every exit-criteria checkbox in `docs/BUILD_PLAN.md` is genuinely met and demonstrable, or is an explicitly flagged soak gate.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
- Report failures plainly, with output. A stage reported complete that is not complete poisons every later stage.

---

## 5. The per-stage ritual — mandatory, not admin overhead

Every stage ends with these four steps. They are part of the stage.

### 5.1 Write the vault entry

Create `vault/modules/M0X-<slug>.md` from `vault/_TEMPLATE.md`, filling **every** section:

- **Summary** — what is now possible that was not before
- **Scope delivered** — including anything deliberately descoped, and where it moved to
- **Components added** — the table of paths and what each is
- **Files changed** — the complete list: added, modified, deleted (see 5.2)
- **Schema changes** — migration ids, and the exact rollback statement for anything not trivially reversible
- **Configuration** — every new env var, its purpose, where to obtain it, whether it is secret
- **Technical decisions** — chosen, rejected, consequence accepted
- **Gotchas and failure modes** — symptom / cause / fix / prevention. *The most valuable section in the file.* Include the dead ends, including the ones that turned out trivial
- **Verifying locally** — exact commands in order, with expected output
- **Performance** — measured numbers with stated conditions, never estimates
- **Rolling back** — how to undo the stage, including migrations and any data written
- **Carried forward** — specific, actionable inherited debt

Vault rules that override convenience: write it **at the end of the stage, not later**; **record the failures**; **never put credentials or student personal data in the vault** — it is committed to git.

### 5.2 Record the files changed

Every vault module entry carries a **Files changed** table. Generate it from the real diff, not from memory:

```bash
git diff --stat <stage-start-commit>..HEAD
git diff --name-status <stage-start-commit>..HEAD
```

Format:

| Status | Path | What changed and why |
|---|---|---|
| added | `packages/geo/src/snap.ts` | forward-biased snapping window (ARCH §5.2) |
| modified | `packages/contracts/src/ping.ts` | added `cadence_s` to `PingBatch` |
| deleted | `apps/…` | … |

Record the stage-start commit SHA in `tracker.md` when the stage begins, so this stays a mechanical command rather than an act of recollection.

### 5.3 Write ADRs for contested decisions

Any decision that was genuinely close gets `vault/decisions/ADR-XXXX-<slug>.md`: options considered, choice, consequence accepted. **The rejected options are the point** — without them, someone re-litigates the same question in six months.

### 5.4 Update the indices

- **`tracker.md`** — mark the stage complete, tick its exit criteria, record the completion date and the end commit, move any new inherited work into the next stage's carried-forward notes, and update the outstanding external dependencies.
- **`vault/README.md`** — add the new entry to the Index section (Modules / Decisions / Runbooks / Benchmarks).
- **`README.md`** — Features, Getting Started, Environment Variables, Project Structure and Roadmap kept accurate against **what actually works today**. A README that overstates the current state is worse than no README.

Also write a runbook to `vault/runbooks/<symptom>.md` whenever a new operational failure mode is discovered — named after the **symptom** someone will search for under pressure ("bus not appearing"), not the cause.

---

## 6. Mid-stage updates

The vault entry is written at the end of a stage, but `tracker.md` is updated **as soon as anything changes**:

- A module, worker or package completed → tick it in the stage's in-progress checklist and append its files to that stage's running "files touched" list.
- An exit criterion met → tick it, with the measured number where the criterion names one.
- A blocker found → record it under the stage, with the date and what it blocks.
- An external dependency moving (DLT registration, roster CSV, ridership figures, the Stage 5 driver arrangement) → update its row immediately. These have multi-week clocks and are the likeliest thing to stall the build.

If a run ends with work in progress, leave `tracker.md` accurate enough that the next run resumes without re-deriving anything.

---

## 7. What not to do

- Do not start a stage whose dependencies are not complete.
- Do not build a later stage's feature because it is convenient while you are already in the file.
- Do not mark an exit criterion met without evidence — a measured number, a passing test, or a demonstrable behaviour.
- Do not write a vault entry that lists only what worked. That is marketing, not engineering.
- Do not commit credentials, real student data, roster contents or phone numbers — to the vault or anywhere else.
- Do not let `docs/` and the code disagree silently.
- Do not add a dependency to `packages/geo`.
- Do not "simplify" any invariant in section 3. Each one is preventing a specific, named failure.

---

## 8. Reference map

| File | What it answers |
|---|---|
| `Read_this_first.md` | How to work on this repository |
| `tracker.md` | Where the project is right now |
| `docs/ARCHITECTURE.md` | How the system is meant to work, and why |
| `docs/BUILD_PLAN.md` | What gets built, in what order, and when it is done |
| `docs/SCHEMA.md` | The data model, and why each constraint exists |
| `vault/modules/` | What actually happened in each stage |
| `vault/decisions/` | Contested decisions, with the rejected options |
| `vault/runbooks/` | What to do when something breaks |
| `vault/benchmarks/` | Measured results |
| `README.md` | What works today, for someone arriving cold |
