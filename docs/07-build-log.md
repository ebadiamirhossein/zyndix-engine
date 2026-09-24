# Zyndix Outbound Engine — Build Log

**File:** `07-build-log.md` · **Started:** 2026-08-23
**Type:** append-only session journal. Newest entry at the top.

**Relationship to the other docs:**
- `09-build-plan-v2.md` — the contract. What we agreed to build, in order. (`05-build-plan.md` held this role until 2026-09-21 and is now historical.)
- `06-build-progress.md` — the status board. Tables, checkboxes, current state at a glance.
- `07-build-log.md` — *this file.* What actually happened, session by session, including the things that went wrong.

The status board tells you where you are. This log tells you how you got there and what you already tried. When a session opens six weeks after the last one, this is the file that saves an hour.

---

## Rules

1. **Every Claude Code session appends one entry before it ends.** Not optional, not "if something notable happened." A session that changed nothing still gets an entry saying so.
2. **Newest first.** Append at the top of §Sessions, under the header.
3. **Record failures.** A dead end you don't write down is a dead end you will walk into again. The `fantasticfrank.co` crawler failure is worth more in this log than three successful steps.
4. **Verification output is the proof.** Paste the actual command and the actual result, not "tested, works."
5. **Update `06-build-progress.md` in the same session.** Status board and log move together or they drift apart, and then neither is trustworthy.
6. **One decision per line in the Decisions block**, with the reason. Reasons prevent re-litigation.

---

## Entry template

```markdown
### YYYY-MM-DD — Session N — <short title>

**Step:** <build plan step number, or "maintenance" / "docs" / "debug">
**Status at end:** 🟨 in progress | ✅ DoD passed | ⛔ blocked

**Did**
- <what changed, concretely>

**Files touched**
- `path/to/file.ts` — <what changed>

**Verification**
```
$ <command run>
<actual output, trimmed>
```
Result: pass / fail

**Decisions**
- <decision> — <why>

**Problems hit**
- <what broke, what fixed it, or what is still open>

**Next action**
- <the single next thing, specific enough to start cold>
```

---

## Sessions

### 2026-09-24 — Session 8 — U2 durable job system

**Unit:** U2 — Durable job system (`09` §U2), branch `feat/u2-jobs`
**Status at end:** ✅ **tested locally** — all four `09` §U2 DoD items pass against Supabase. No provider is involved, so this is the highest status U2 can reach.

**Did**
- `jobs` table with a state check constraint, a partial-unique `idempotency_key`, partial indexes for the two claim predicates, `trg_updated_at` and RLS.
- `claim_jobs(owner, types[], limit, lease_seconds)` RPC: `FOR UPDATE SKIP LOCKED`, re-claims expired leases, increments `attempts` at claim, dead-letters an expired lease on its final attempt. `security definer` with a pinned `search_path`; PUBLIC/anon/authenticated execute revoked.
- `src/lib/jobs/`:
  - `backoff.ts`: capped exponential backoff, 30s base, ×2, 1h cap, ±20% jitter clamped to the cap.
  - `registry.ts`: `defineJob` with a Zod payload schema, `PermanentJobError`, duplicate-type rejection.
  - `queue.ts`: enqueue with idempotent dedupe; claim; lease-fenced complete and fail; cancel only from `queued`.
  - `worker.ts`: one bounded pass with a wall-clock budget, one claim at a time, a per-handler timeout with `AbortSignal`, and backoff or dead-letter on failure.
  - `index.ts`: the `server-only` binding.
- `scripts/test-u2-jobs.ts` plus `pnpm test:jobs`.
- The operator applied both migrations in the SQL editor (the repo has no DB URL).
- The 🛒 Instantly/mailbox/MillionVerifier purchase is the operator's separate task, per their instruction. U2's code did not wait on it. `06` §1 now says it is due.

**Files touched**
- `supabase/migrations/0006_jobs.sql`, `supabase/migrations/0006b_claim_jobs_rpc.sql`: new
- `src/lib/jobs/{backoff,registry,queue,worker,index}.ts`: new
- `src/types/enums.ts`: `JOB_STATES`, `jobStateSchema`
- `src/types/database-extensions.ts`: `DatabaseWithJobs` (table + `claim_jobs`), same pattern as `DatabaseWithAppUsers`
- `scripts/test-u2-jobs.ts`: new; `package.json`: `test:jobs`
- `docs/06-build-progress.md`: header, §1 (purchase rows, migration row), §2 U2 row, §5 five decisions
- `docs/07-build-log.md`: this entry

**Verification**

Before applying, the SQL was checked against a throwaway local Postgres 16 cluster in the session scratchpad. It confirmed:
- lease and re-claim, with `attempts` going 1 → 2 under the same `idempotency_key`
- the final-attempt dead-letter
- grants: `postgres` and `service_role` only
- `p_limit=0` rejected
- two overlapping transactions: A held a transaction open on 15 rows while B claimed. B skipped them and got the other 5, 0 overlap.

That was a pre-flight, not the DoD.

Operator, after applying (reported in chat):
```
jobs            relrowsecurity = true
claim_jobs      EXECUTE: postgres, service_role, supabase_admin   (anon, authenticated absent)
```

```
$ pnpm exec tsc --noEmit        → clean
$ pnpm build                    → clean
$ pnpm lint                     → ✖ 21 problems (17 errors, 4 warnings) — identical to main (09 §5 backlog);
                                  eslint on src/lib/jobs, src/types, scripts/test-u2-jobs.ts → exit 0

$ pnpm test:jobs

=== test-u2-jobs (tag=test.u2.1790268746566) ===

--- backoff (pure) ---
PASS: attempt 1 waits baseMs — 30000ms
PASS: attempt 2 doubles — 60000ms
PASS: delays are non-decreasing — 30000,60000,120000,240000,480000,960000,1920000,3600000,3600000,3600000
PASS: cap is respected at attempt 50 — 3600000ms
PASS: attempt 0 or negative treated as 1
PASS: jitter stays within ±20% over 1000 draws — range 96034..143938
PASS: jitter never pushes past the cap

--- registry (pure) ---
PASS: duplicate job type is rejected
PASS: registry lists its types
PASS: invalid payload throws PermanentJobError(invalid_payload) — invalid_payload: {"formErrors":[],"fieldErrors":{"n":["Inval

BEFORE  leads=34 touches=4 lead_events=219 jobs=0

--- DoD 1: concurrent claim_jobs return disjoint sets ---
PASS: round 1: intersection = ∅ — A=15 B=5 ∩=0 ∪=20
PASS: round 1: all 20 claimed exactly once
PASS: round 1: every row leased to its claimer at attempts=1
  (rounds 2–4 identical: A=15 B=5 ∩=0 ∪=20, 3 PASS each)
PASS: round 5: intersection = ∅ — A=5 B=15 ∩=0 ∪=20
PASS: round 5: all 20 claimed exactly once
PASS: round 5: every row leased to its claimer at attempts=1

--- DoD 2: a throwing handler re-queues with backoff ---
PASS: worker reports one retry — {"claimed":1,"completed":0,"retried":1,"dead":0,"leaseLost":0,"stoppedReason":"max_jobs","elapsedMs":373}
PASS: attempts = 1 — attempts=1
PASS: state = 'queued' — queued
PASS: run_after > now() — 2026-09-24T16:53:23.312+00:00
PASS: last_error populated — Error: synthetic handler failure
PASS: lease cleared

--- DoD 3: dead after max_attempts ---
PASS: handler ran exactly max_attempts times — calls=3
PASS: state = 'dead' — dead
PASS: attempts = max_attempts = 3 — attempts=3
PASS: last_error populated with the final failure — Error: synthetic failure #3
PASS: finished_at set
PASS: summary: 2 retried, 1 dead — {"claimed":3,"completed":0,"retried":2,"dead":1,"leaseLost":0,"stoppedReason":"drained","elapsedMs":1173}
PASS: PermanentJobError → dead after 1 attempt, no retry — state=dead attempts=1 calls=1
PASS: invalid payload → dead with invalid_payload, handler never called — state=dead calls=0

--- DoD 4: expired lease is re-claimable with the same idempotency_key ---
PASS: first worker claims it
PASS: a live lease is NOT re-claimable — claimed=0
PASS: expired lease is re-claimed by another worker — 3b65b4b6-c9ae-4bff-898f-585a2c2f5c1d
PASS: re-claimer sees the same idempotency_key — test.u2.1790268746566-idem-lease
PASS: re-claim counts as attempt 2 — attempts=2
PASS: lease now belongs to the re-claimer
PASS: the crashed worker's late complete() is fenced off — result=lease_lost state=leased
PASS: the re-claimer completes it
PASS: expired lease at final attempt → dead, not re-claimed — claimed=0 state=dead last_error=lease_expired_after_final_attempt

--- idempotent enqueue ---
PASS: second enqueue is deduped
PASS: exactly one row for the key — count=1

--- cancel ---
PASS: queued job cancels
PASS: cancelled job is not claimable
PASS: leased (in-flight) job is NOT cancelled

--- wall-clock budget ---
PASS: pass stops on budget, not by draining — {"claimed":3,"completed":3,"retried":0,"dead":0,"leaseLost":0,"stoppedReason":"budget","elapsedMs":1616}
PASS: pass returns within budget — elapsed=1616ms budget=2500ms
PASS: some but not all jobs ran — done=3
PASS: no job stranded in 'leased' — done=3 queued=7 leased=0

--- handler timeout ---
PASS: timeout → retry with job_timeout recorded — state=queued last_error=JobTimeoutError: job_timeout: handler exceeded 200ms
PASS: handler's AbortSignal fired

Cleanup: removed 120 fixture job(s).
AFTER   leads=34 touches=4 lead_events=219 jobs=0
PASS: leads count unchanged — 34 → 34
PASS: touches count unchanged — 4 → 4
PASS: lead_events count unchanged — 219 → 219
PASS: jobs count unchanged — 0 → 0

All 63 checks passed.
```
(Worker `owner` UUIDs trimmed from the summaries; rounds 2–4 collapsed. Nothing else edited.)

Result: **pass**, U2 DoD:
1. disjoint concurrent claims, 5 rounds
2. throw → `attempts=1`, `queued`, `run_after > now()`
3. `dead` after `max_attempts` with `last_error`
4. an expired lease is re-claimable with the same `idempotency_key`

Every fixture used a `test.u2.<ts>.*` type, and every claim named only those types. No real row was selectable.

**Decisions**
- `attempts` increments at claim: a crash must spend an attempt, or a poison job loops forever (`06` §5).
- Writes after claim are lease-fenced on `id + state + lease_owner + attempts`, so a superseded worker cannot overwrite the new holder (`06` §5).
- The worker claims one job at a time, so a budget stop cannot strand a leased-but-unstarted job (`06` §5).
- `jobs.state` has a check constraint: an unknown state is a silently lost job (`06` §5).
- `claim_jobs` pins `search_path` and revokes PUBLIC. `transition_lead` stays as is; it is in the backlog, out of scope (`06` §5).
- There is no cron route. `/api/cron/orchestrate` is U9's, and U2's `Touches` list names none.
- Types extend `database-extensions.ts` rather than rerunning `gen:types`, because there is no `SUPABASE_DB_URL` locally. That matches the existing pattern.

**Problems hit**
- The local Postgres pre-flight hit three snags: `initdb` needed `LANG=C`; the scratchpad path exceeded the 103-byte Unix socket limit (fixed with a short temp socket dir); zsh does not word-split a `$P` command variable (fixed with a shell function). All were tooling only.
- The first registry draft typed definitions as `JobDefinition<never>[]`, which Zod's covariant output type would reject. Replaced with a type-erased `RegisteredJob` whose `run()` Zod-parses the payload. Caught before the first `tsc`.

**Open, carried forward**
- 🛒 Instantly Hypergrowth, the four mailboxes, MillionVerifier credits and `STEP-11-RUNBOOK.md` §B.0 DNS: the operator's task, now due. Each day of delay comes off U6's warmup.
- A handler that ignores its `AbortSignal` keeps running after its timeout, and its job is already re-queued. Every handler with side effects must be idempotent on `idempotencyKey`. U5 relies on this; its outbox row is written before the provider call.
- No lease heartbeat. The lease is sized from each handler's `timeoutMs` plus a 30s margin. Add one only if a job type needs runs longer than its lease.
- Vercel env items from Session 7 (`SUPABASE_ANON_KEY`, `DASHBOARD_ALLOWED_EMAILS`, callback URL, `ANTHROPIC_API_KEY`) are unchanged.

**Next action**
- **U3: scheduler, atomic capacity ledger and send windows.** Start with `0007_capacity_counters.sql` (additive `reserved`, `accepted`, `failed`, `reconciled` on `capacity_ledger`). Then `0007b_reserve_capacity.sql` on the `claim_jobs` RPC pattern (pinned `search_path`, PUBLIC revoked). The DoD needs exactly 15 `ok` out of 30 concurrent reservations.

---

### 2026-09-24 — Session 7 — `source_cursors` RLS verified

**Unit:** U1 — closes the one DoD item Session 6 left as inferred. No code changed.
**Status at end:** ✅ U1 **tested locally**, all four `09` §U1 DoD items now proven directly

**Did**
- The operator ran the verification query from `0005_app_users_roles.sql`'s trailer in the Supabase SQL editor.
- Closed the carried item in `06` §6: the `source_cursors` RLS flag is now **proven**, not inferred.

**Files touched**
- `docs/06-build-progress.md` — §6 `source_cursors` row
- `docs/07-build-log.md` — this entry

**Verification**

Run by the operator in the SQL editor. The result was reported in chat rather than pasted as raw output:
```
select relname, relrowsecurity
  from pg_class
 where relnamespace = 'public'::regnamespace
   and relname in ('app_users', 'source_cursors', 'leads')
 order by relname;

 relname        | relrowsecurity
----------------+----------------
 app_users      | t
 leads          | t
 source_cursors | t
```
Result: **pass**. This is `09` §U1 DoD item 4. `leads` was included as a control: it has had RLS since `0001`.

With this, Session 6's item 4 ("inferred, not queried") is closed. All four U1 DoD items have direct evidence.

**Decisions**
- None.

**Problems hit**
- None.

**Open, carried forward**
- Whether `SUPABASE_ANON_KEY`, `DASHBOARD_ALLOWED_EMAILS` and the production callback URL are on Vercel/Supabase cannot be checked from the repo. Check before any dashboard deploy (`06` §6).
- The new `ANTHROPIC_API_KEY` is still not in the Vercel env (carried since Session 2).

**Next action**
- **U2 — durable job system.** It opens with the 🛒 purchase (Instantly Hypergrowth, four mailboxes, MillionVerifier credits, then `STEP-11-RUNBOOK.md` §B.0 DNS on `zyndixhq.com` and `getzyndix.com`), which needs the operator's go-ahead under the cost gate.

---

### 2026-09-24 — Session 6 — U1 DoD passed

**Unit:** U1 — Authentication, roles, dashboard shell
**Status at end:** ✅ **tested locally**

**Did**
- The operator completed the four blocked steps from Session 4: applied `0005_app_users_roles.sql`, set `SUPABASE_ANON_KEY` and `DASHBOARD_ALLOWED_EMAILS`, and enabled the Supabase email provider with the localhost callback allow-listed.
- The operator reported 48/48, a magic-link sign-in end to end as `admin`, and all ten dashboard areas rendering.
- Re-ran the DoD script in this session so the log holds real output, not a summary. It reproduced 48/48.
- Marked U1 **tested locally** in `06` §2; updated §1 prerequisites and closed two §6 rows.

**Files touched**
- `docs/06-build-progress.md` — header date, §1 (four U1 rows), §2 U1 row, §6 (two rows closed, one opened)
- `docs/07-build-log.md` — this entry

No code changed.

**Verification**

`.env.local`, key presence only — no value read or printed:
```
SUPABASE_ANON_KEY: present, non-empty
DASHBOARD_ALLOWED_EMAILS: present, non-empty
```

```
$ pnpm tsx scripts/test-u1-auth.ts --base-url http://localhost:3000

--- allow-list parsing ---
(10 PASS)

--- assertRole matrix ---
PASS: ROLE_RANK orders viewer < operator < admin — {"viewer":0,"operator":1,"admin":2}
PASS: viewer may act as viewer
PASS: viewer may NOT act as operator
PASS: viewer may NOT act as admin
PASS: operator may act as viewer
PASS: operator may act as operator
PASS: operator may NOT act as admin
PASS: admin may act as viewer
PASS: admin may act as operator
PASS: admin may act as admin
PASS: no role at all is forbidden, not allowed
PASS: viewer is refused operator
PASS: operator is refused admin

--- route registry ---
PASS: registry is non-empty — 2 route(s)
PASS: every registry entry is classified session or machine
PASS: every session route names a required role
PASS: every mutating route on disk is in the registry — 3 route file(s) scanned

--- app_users store ---
BEFORE  leads=34 touches=4 lead_events=219 app_users=1
PASS: three synthetic auth users created
PASS: unprovisioned user has no app_users row
PASS: ensureAppUser provisions with the given role — viewer
PASS: getAppUser returns the provisioned row
PASS: ensureAppUser does NOT overwrite an existing role from the env — role stayed viewer
PASS: ensureAppUser is idempotent — no duplicate row
PASS: role can be promoted by DB update
PASS: promotion is visible to getAppUser — operator
PASS: promoted user now passes the operator gate
PASS: an unrecognised role is rejected by the check constraint — 23514: new row for relation "app_users" violates check constraint "
Cleanup: removed 3 synthetic auth user(s).
AFTER   leads=34 touches=4 lead_events=219 app_users=1
PASS: leads count unchanged — 34 → 34
PASS: touches count unchanged — 4 → 4
PASS: lead_events count unchanged — 219 → 219
PASS: app_users count unchanged — FK cascade cleaned up — 1 → 1

--- source_cursors trigger ---
PASS: service_role can still write source_cursors with RLS on
PASS: insert keeps the app-supplied updated_at (trigger is BEFORE UPDATE only) — 2020-01-01T00:00:00+00:00
PASS: source_cursors row updates
PASS: update applied — 2
PASS: trg_updated_at fired on update — updated_at advanced — 2026-09-24T16:13:36.717267+00:00
Cleanup: removed fixture source_cursors row.

--- HTTP surface ---
PASS: GET /dashboard redirects to /login — 307 → /login
PASS: unauthenticated POST /api/auth/signout → 401 — got 401

All 48 checks passed.
```
Result: **pass** — U1 DoD. Non-fixture row counts identical before and after.

The one pre-existing `app_users` row is the operator's own sign-in, and its role is as reported:
```
$ (service-role read of app_users: role, created_at)
[{"role":"admin","created_at":"2026-09-24T16:12:27.213271+00:00"}]
```

**How each of `09` §U1's four DoD items was met**
1. `/dashboard` → redirect to `/login` — **pass**, 307 (see the Session 4 note on 307 vs 302).
2. A viewer is refused `operator` with a 403 and no DB write — **pass**. The rule is proven by the `assertRole` matrix, the 403 mapping by `ForbiddenError.status`, and "no write" by the unchanged row counts.
3. An unauthenticated POST to every registered session route → 401 — **pass**, iterated over the registry, and the registry is itself checked against every `route.ts` on disk.
4. `source_cursors` `relrowsecurity = true` — **inferred, not queried.** The migration applied: `app_users` exists and the `source_cursors` trigger fires, and both of those statements come after the `enable row level security` line. But the `relrowsecurity` query in the migration's trailer has not been run and pasted, so this item is not independently proven.

**Operator-verified, not reproduced here**
- Magic-link sign-in end to end, and the ten areas rendering while signed in. Both need a real inbox and a browser session, so they are recorded as the operator reported them. The `admin` row above corroborates the sign-in.

**Decisions**
- **U1 is "tested locally". Supabase Auth itself is not promoted to "verified with provider" in this entry.** — The real magic-link round trip meets the Session 4 bar for that label, but it was operator-run, on localhost, and the operator asked for "tested locally". Promoting it is a one-line change once the operator decides.

**Problems hit**
- None.

**Open, carried forward**
- Run the `relrowsecurity` query in `0005`'s trailer and paste the result here. It is the only DoD item with no direct evidence.
- Whether `SUPABASE_ANON_KEY`, `DASHBOARD_ALLOWED_EMAILS` and the production callback URL exist on Vercel/Supabase cannot be checked from the repo. Check before any dashboard deploy (`06` §6).
- Still outstanding since Session 2: the new `ANTHROPIC_API_KEY` is not in the Vercel env.

**Next action**
- **U2 — durable job system**, and at its start the 🛒 purchase: Instantly Hypergrowth, four Google Workspace mailboxes, MillionVerifier credits, then `STEP-11-RUNBOOK.md` §B.0 DNS on `zyndixhq.com` and `getzyndix.com` first. That purchase needs your go-ahead under the cost gate.

---

### 2026-09-24 — Session 5 — Record the sending domain names

**Unit:** docs — closes open operator input #4 from Session 4. No code changed.
**Status at end:** ✅ done

**Did**
- Recorded the two sending domains bought on 2026-09-21: **`zyndixhq.com`** and **`getzyndix.com`**.
- Replaced the `⬜` placeholders in `06-build-progress.md` §1 and `STEP-11-RUNBOOK.md` §A.1, and ticked the matching Clock A checklist item in the runbook's §E.

**Files touched**
- `docs/06-build-progress.md` — §1 sending-domains row
- `docs/STEP-11-RUNBOOK.md` — §A.1 table and note, §E checklist
- `docs/07-build-log.md` — this entry

**Verification**
```
$ grep -rn "record the domain\|Names not yet recorded\|not yet written down" docs/06-build-progress.md docs/STEP-11-RUNBOOK.md
(no output)
```
Result: **pass**. No placeholders left.

**Decisions**
- **The runbook §B.2 mailbox table still says "Domain A" / "Domain B".** Which mailboxes go on which domain is the operator's call at purchase time, so it was left alone rather than filled in with a guessed mapping.

**Problems hit**
- None.

**Next action**
- Unchanged from Session 4: apply `0005`, set `SUPABASE_ANON_KEY` and `DASHBOARD_ALLOWED_EMAILS`, enable the Supabase email provider, then run `pnpm tsx scripts/test-u1-auth.ts --base-url http://localhost:3000` for 48/48 and paste the output here.
- Then **U2**, which is also the 🛒 purchase trigger.

---

### 2026-09-21 — Session 4 — U1 auth, roles, dashboard shell; purchase trigger to U2; UD added

**Unit:** U1 — Authentication, roles, dashboard shell
**Status at end:** 🟨 **implemented** — 29/29 runnable checks pass, 19 blocked on operator steps

**Did**
- Fast-forwarded `main` from `e2feda2` to `3142c58`. `09-build-plan-v2.md`, `08-complete-build-brief.md`, the rewritten `CLAUDE.md`/`06`/runbook and `scripts/ping.ts` were all sitting on the unmerged `docs/adopt-complete-brief`, so `main` documented a `ping.ts` it did not contain. `src/` and `supabase/` were byte-identical, so it was a clean fast-forward. Branched `feat/u1-auth` from it.
- Built U1: migration `0005`, the `requireRole()` primitive and its supporting lib, magic-link sign-in, the ten-area dashboard shell, `src/proxy.ts`, and `scripts/test-u1-auth.ts`.
- Moved the 🛒 Instantly purchase trigger from U3 to U2 across `09`, the runbook and `06`, and rewrote the rationale — the old one was based on a premise that turned out to be impossible.
- Added unit **UD — Apply design system** to `09`, between U7 and U8.
- Recorded four decisions in `06` §5 and five new items in `06` §6.

**Files touched**
- `supabase/migrations/0005_app_users_roles.sql` — new. `app_users`; RLS + `trg_updated_at` on `source_cursors`
- `src/lib/auth/{core,allowlist,supabase,session,require-role,route-registry}.ts` — new. `cron.ts` untouched
- `src/app/login/{page,form,actions}.tsx|ts`, `src/app/api/auth/{callback,signout}/route.ts` — new
- `src/app/dashboard/{layout.tsx,nav.ts}` + ten `page.tsx` — new; `.gitkeep` removed
- `src/proxy.ts` — new
- `src/types/enums.ts` — `APP_ROLES`; `src/types/database-extensions.ts` — `app_users`
- `src/app/layout.tsx` — create-next-app metadata replaced
- `scripts/test-u1-auth.ts` — new, 48 checks (29 runnable today, 19 gated on migration `0005`)
- `package.json` — `@supabase/ssr` added, `@supabase/supabase-js` 2.110.1 → 2.116.0
- `.env.local.example` — `SUPABASE_ANON_KEY`, `DASHBOARD_ALLOWED_EMAILS`
- `docs/09-build-plan-v2.md`, `docs/STEP-11-RUNBOOK.md`, `docs/06-build-progress.md`, `docs/07-build-log.md`

**Verification**

```
$ pnpm exec tsc --noEmit
(clean, exit 0)

$ pnpm build
✓ Compiled successfully in 2.2s
├ ƒ /dashboard          (all ten areas dynamic)
ƒ Proxy (Middleware)
```

```
$ curl -i -s http://localhost:3000/dashboard | head -2
HTTP/1.1 307 Temporary Redirect
location: /login

$ curl -i -s -X POST http://localhost:3000/api/auth/signout | head -1
HTTP/1.1 401 Unauthorized
```

All ten areas, unauthenticated:
```
/dashboard            307 -> http://localhost:3000/login
/dashboard/knowledge  307 -> http://localhost:3000/login
/dashboard/products   307 -> http://localhost:3000/login
/dashboard/companies  307 -> http://localhost:3000/login
/dashboard/campaigns  307 -> http://localhost:3000/login
/dashboard/approvals  307 -> http://localhost:3000/login
/dashboard/inbox      307 -> http://localhost:3000/login
/dashboard/pipeline   307 -> http://localhost:3000/login
/dashboard/integrations 307 -> http://localhost:3000/login
/dashboard/reports    307 -> http://localhost:3000/login
```

```
$ pnpm tsx scripts/test-u1-auth.ts --base-url http://localhost:3000
--- allow-list parsing ---      (10 PASS)
--- assertRole matrix ---       (13 PASS, all 9 role pairs asserted by name)
--- route registry ---          (4 PASS)
--- app_users store ---
SKIP: app_users store (14 checks) — 0005_app_users_roles.sql not applied yet
SKIP: source_cursors trigger (5 checks) — 0005_app_users_roles.sql not applied yet
--- HTTP surface ---
PASS: GET /dashboard redirects to /login — 307 → /login
PASS: unauthenticated POST /api/auth/signout → 401 — got 401

All 29 checks passed.
```
Result: **pass on everything runnable.** Not a full DoD — see *Blocked* below.

No regression:
```
$ pnpm tsx scripts/ping.ts           All 3 checks passed.
$ pnpm tsx scripts/test-validation.ts All 16 checks passed.
$ pnpm tsx scripts/test-state.ts      All 11 checks passed.
$ pnpm tsx scripts/test-settings.ts   All 8 checks passed.
```

`scripts/test-source.ts` was **not** run: it calls Apollo live and creates leads, which is behind the cost gate. The `source_cursors` trigger it would have exercised is instead covered directly by group 4b of `test-u1-auth.ts`, which touches no provider.

**Blocked — four operator steps**
1. Apply `supabase/migrations/0005_app_users_roles.sql` in the SQL editor; run the verification query in its trailer.
2. Set `SUPABASE_ANON_KEY` and `DASHBOARD_ALLOWED_EMAILS` in `.env.local`.
3. Supabase → enable the Email provider, allow-list `http://localhost:3000/api/auth/callback`.
4. Record the two purchased domain names — `STEP-11-RUNBOOK.md` §A.1 and `06` §1 both hold a `⬜` placeholder. They are U5's allowed-sender list.

**Decisions**
- **🛒 moves from U3 to U2, and the old rationale was wrong.** — `09` said doing the domains' DNS immediately was what let the purchase wait until U3. But runbook §A.2's DKIM step runs through Google Workspace Admin, and Workspace is bought in clock B — so clock A could never have delivered "full DNS". DNS authentication is inherently gated on the mailbox purchase. Buying at U2 (≈ day 7) instead of U3 (≈ day 11) buys four days, which is what funds the DNS work on purchase day. Warmup ≈ days 9–33, about **24 days**, up from 21.
- **The dashboard ships unstyled; UD applies the design system.** — The system is authored in Claude Design, outside the repo. UD sits between U7 and U8 because U8 is the first unit that renders real data: styling earlier means styling empty pages, later means restyling. Lettered rather than numbered so no `depends on` reference or migration number shifts. Milestones 🛒 and 🚩 are above it and do not move; ⭐ slips from session 38 to 40.
- **Roles bootstrap from the env, then the DB is authority.** — `DASHBOARD_ALLOWED_EMAILS` uses `email:role`; a bare email is `viewer`. `ensureAppUser` inserts only when missing and never overwrites an existing role, so a role change is a DB update, not a redeploy. "First user wins admin" was rejected — privilege should not depend on who clicks first.
- **The anon key is server-only, not `NEXT_PUBLIC_`.** — Sign-in is a server action and the callback is a route handler, so no client component ever holds a Supabase client. The repo had zero client-side Supabase usage and `authenticated` is granted nothing, so publishing the key would buy nothing.
- **Auth fails closed on missing config.** — `getAuthUser()` catches a missing `SUPABASE_ANON_KEY` and returns null rather than throwing. An unconfigured deployment reads as "nobody is signed in", so a mutating route answers 401 instead of 500. `proxy.ts` has the same fallback.

**Deviations from `09` §U1, all deliberate**
- **`middleware.ts` → `src/proxy.ts`.** Next 16 renamed Middleware to Proxy (`node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`). It lives in `src/` because `app/` does. `09`'s text predates the rename.
- **`app_users.role` has a `check` constraint** — the schema's first. The repo has no check constraints and enforces state legality in app code, but a role is a privilege boundary and an unrecognised value must not be insertable. Recorded in `06` §5 as an exception, not drift.
- **The redirect is 307, not the 302 the DoD names.** `NextResponse.redirect` defaults to 307, which preserves the method. The test accepts either.
- **Six lib files, not the two `09` lists.** `09` names `{session,require-role}.ts`; the repo's split convention (pure `core.ts` + `"server-only"` binder, as in `state.ts`/`state/core.ts`) wanted `core`, `allowlist`, `supabase` and `route-registry` alongside them.

**Problems hit**
1. **The build failed by prerendering the dashboard.** `Error occurred prerendering page "/dashboard/approvals": Missing SUPABASE_URL or SUPABASE_ANON_KEY`. `createAuthClient` threw on the env check *before* `await cookies()`, so Next never saw a dynamic signal and tried to build the pages statically. Fixed two ways: `export const dynamic = "force-dynamic"` on the dashboard layout and login page — an authenticated area must never be prerendered anyway — and `cookies()` moved above the env check. `cacheComponents` is off, so `force-dynamic` is the applicable opt-out.
2. **A PostgREST trap worth remembering: `head: true` against a missing table returns 204, no error, null count.** The first version of the migration probe used a head request and cheerfully reported `app_users` as present-and-empty; `countRows()` had the same bug, and would have let a before/after comparison "pass" against a table that does not exist. Probe now uses a body select (real 404/`PGRST205`), and `countRows()` throws on a null count.
3. **`@supabase/ssr@0.12.7` needs `supabase-js@^2.114.0`**; the repo had 2.110.1. Bumped to 2.116.0 — same major — and re-ran `tsc`, `build`, `test-validation`, `test-state` and `test-settings` before writing any U1 code, so a bump regression could not be confused with new work. All clean.
4. **`pnpm lint` already fails on `main`** — 17 `no-explicit-any` errors in `scripts/compare-prompt-versions.ts`, `rerun-qualifier-one.ts` and `test-qualify.ts`, plus 4 unused-var warnings. Verified pre-existing by stashing U1 and re-running: **identical 21 problems before and after.** Not fixed — out of scope. Backlogged in `09` §5.
5. **`0002_transition_lead.sql` is `security definer` with no `set search_path`**, which Supabase's linter flags as `function_search_path_mutable`. Noticed while matching the RPC pattern. Not touched — fixing it needs a new migration replacing the function. Backlogged in `09` §5.

**Note on `docs/03-architecture.md`**
§6 still specifies "simple email allow-list via NextAuth (or Supabase Auth) — two users, **no roles complexity**". Brief §3 requires three roles and is authority #1, so the brief wins and U1 implements three. `03` is not corrected here; its reconciliation is U23's job.

**Next action**
- **Operator:** the four blocked items above, then `pnpm dev` and `pnpm tsx scripts/test-u1-auth.ts --base-url http://localhost:3000` for the full 48/48. Paste the result and the migration verification query's output here.
- Then **U2 — durable job system**, which is also the 🛒 **Instantly purchase trigger**: Instantly Hypergrowth, four mailboxes, MillionVerifier credits, and all remaining DNS on both sending domains (`STEP-11-RUNBOOK.md` §B.0 first).
- Still outstanding since Session 2: **put the new `ANTHROPIC_API_KEY` into the Vercel env.**

---


### 2026-09-21 — Session 3 — Adopt the complete build brief

**Unit:** docs / reconciliation + repair — Phase 1 repair half. No product features.
**Status at end:** ✅ DoD passed

**Did**
- Verified brief §2's description of the repo against the actual tree. It is accurate on every substantive claim; six differences found and recorded below.
- Rewrote `scripts/test-draft.ts` against isolated synthetic fixtures. It was the last destructive script in the repo and the reason step 10 had never been run.
- Wrote `scripts/ping.ts`, which step 1's DoD has named since July without it existing.
- Wrote `docs/09-build-plan-v2.md` — 23 units across the brief's six phases, with a first-send milestone and an Instantly purchase trigger.
- Realigned `01`–`05` (banners), `06` (unit tracker), `STEP-11-RUNBOOK.md` (split purchase clocks).

**Files touched**
- `scripts/test-draft.ts` — rewritten, 369 → 588 lines
- `scripts/ping.ts` — new, 111 lines
- `package.json` — added `pnpm ping`
- `docs/09-build-plan-v2.md` — new, 655 lines
- `docs/06-build-progress.md` — step tracker replaced with a unit tracker
- `docs/STEP-11-RUNBOOK.md` — rewritten, Day 0 split into two clocks
- `docs/01`–`05` — supersession banners
- `docs/07-build-log.md` — this entry

**Baseline differences vs brief §2**

Brief §2 is correct that the repo is Next.js 16.2.10, migrations `0000`→`0004`, with Apollo/Apify/Anthropic/MillionVerifier/drafting/Telegram/state/settings/proof+CTA present, and Instantly sending, capacity scheduling, reply and Calendly webhooks, the classifier, orchestration and the dashboard absent. Six differences worth recording:

1. **Docs were renamed and uncommitted.** `docs/01-PRD.md`…`07-build-log.md` showed as deleted with `Engine-`-prefixed copies untracked, while `CLAUDE.md`, the brief §1 and every cross-doc link still used the unprefixed names. Renamed back — the copies were byte-identical, so git now shows no change for them.
2. **`_ping` does not exist.** `0000_ping.sql` creates it; `0001_init_schema.sql` ends with `drop table if exists _ping;`. Step 1's "reads/writes a test row" DoD was unrunnable against the real schema. `ping.ts` is therefore read-only.
3. **The absent pieces are `.gitkeep` directories, not missing paths** — `src/lib/scheduler/`, `src/app/dashboard/`, `api/cron/{orchestrate,daily}`, `api/webhooks/{instantly,calendly}`, `api/attio/sync`. Brief §13's "feature flags and integration availability must not conceal incomplete implementation" applies; the tracker keeps calling them absent.
4. **Schemas exist ahead of their implementations.** `instantlyWebhookSchema`, `replyClassifierOutputSchema` and `capacityDefaultsSchema` are written, and the classifier schema is unit-tested, with **no stage consuming any of them**. Real reuse for U3/U6/U7 — not evidence of progress.
5. **`STEP-11-RUNBOOK.md` claimed a guard that does not exist.** Line 14 said the `zyndix.com` block was "already enforced by a code guard in `stages/send.ts`". There is no `stages/send.ts`. Corrected; the guard arrives at U5 and that unit's DoD verifies it.
6. **`source_cursors` has no RLS and no `updated_at` trigger.** `0001` enables RLS on all 16 of its tables; `0004` adds a 17th and enables nothing. Not exploitable today — `0001` grants tables to the engine role only and leaves `anon`/`authenticated` ungranted — but it breaks the pattern. Scheduled into U1's migration `0005`; not touched this session, which ships no migrations.

**Nothing changed in the repo since the 2026-08-23 entry.** `HEAD` was `e2feda2`; the last code commit was `0e772ab` (step 10). Every working-tree change was the doc rename plus the new brief and `CLAUDE.md`. `.env.local` is gitignored and has never been committed — no secret in history.

**Verification**

```
$ pnpm tsx scripts/ping.ts

=== ping (read-only Supabase round-trip) ===

PASS: settings readable (URL + service-role key valid) — 28 row(s)
PASS: leads readable (migration 0001 applied) — 34 row(s)
PASS: transition_lead RPC exists (migration 0002 applied) — P0001: lead 00000000-0000-0000-0000-000000000000 not found

round-trip: 8402ms
All 3 checks passed.
```
Result: **pass** — step 1 DoD, by the read-only route.

```
$ pnpm tsx scripts/test-draft.ts --limit 1

BEFORE  leads=34 touches=4 lead_events=219

Seeded 1 fixture lead(s) in 'drafting': bcee763a-f30c-49f1-b487-bf2e6a98e882
[draft] generic guard passed — matched tool: "Follow Up Boss"

--- Draft stage summary ---
{ "leads_picked": 1, "drafted": 1, "generic_rejected": 0,
  "parked_generic": 0, "failed": 0,
  "tokens_used": 1515, "est_cost_usd": 0.006093 }

PASS: stage picked only fixture leads — leads_picked=1, fixtures=1
PASS: ... → pending_approval — pending_approval
PASS: ... touch status pending_approval
PASS: ... draft_body set    PASS: ... body null
PASS: ... prompt_version recorded — 7
PASS: ... model body ≤120 words — 84
PASS: ... generic guard — tool: "Follow Up Boss"
(7 banned-phrase checks, 7 client-claim checks, signature, placeholder — all PASS)

--- Telegram approve path (fixture touch) ---
PASS: approve → touch status approved — approved
PASS: approve → body copied from draft_body
PASS: approve → lead state approved — approved

--- Non-whitelisted callback rejection ---
[telegram] rejected user 999999999: callback_query from non-whitelisted user
PASS: non-whitelisted callback rejected

Cleanup: removed 1 fixture lead(s), company(ies) and all related rows.

BEFORE  leads=34 touches=4 lead_events=219
AFTER   leads=34 touches=4 lead_events=219
PASS: leads count unchanged — 34 → 34
PASS: touches count unchanged — 4 → 4
PASS: lead_events count unchanged — 219 → 219

32/32 passed
```
Result: **pass** — step 10 DoD, approve path. **Non-fixture row counts identical before and after**, which is the non-destructiveness proof.

The generated draft, for the record — 84 words, no invented numbers, anchored on the tool named in the fixture's own evidence:

> **out-of-hours leads on your site**
> Your contact page routes enquiries to a shared team address with no auto-response — which means anyone who fills out a form on a Friday evening is sitting in an inbox until Monday morning. That gap isn't a staffing problem, it's a routing one. The lead already moved on before anyone checked email, and Follow Up Boss never even got the record. I've mapped out a few fixes specific to how your site is set up right now. Want me to send them over?

```
$ pnpm tsx scripts/purge-test-data.ts
No test companies found (*.example.com, State Test Co, or Test Lead).
```
Result: **pass** — no fixture leaked.

```
$ pnpm tsx scripts/test-validation.ts   All 16 checks passed.
$ pnpm tsx scripts/test-state.ts        All 11 checks passed.
$ pnpm tsx scripts/test-settings.ts     All 8 checks passed.
$ pnpm exec tsc --noEmit                (clean)
$ pnpm build                            ✓ Compiled successfully
```
Result: **pass** — no regression.

**Cost:** $0.0061 Anthropic (1,515 tokens) plus one earlier aborted run at $0.0061. Two Telegram messages to the operator's own chat. No prospect contacted.

**Decisions**
- **`08-complete-build-brief.md` is the scope authority.** — Docs 01–05 keep a banner rather than being deleted; they are still the accurate record of how existing code was built.
- **Phase 4 executes before Phase 2**, inverting brief §14's order. — Every first touch is operator-approved in Telegram and the proof line is operator-written, so the approval gate covers the generic-copy risk. The binding constraint on revenue is that `stages/send.ts` does not exist, not that a library does not exist. First send runs on the existing draft stage with a minimal single-campaign config; U14/U17 migrate it onto campaigns and matching.
- **Two purchase clocks, not one.** — Domains now (cheap, and age only accrues); Instantly plus mailboxes at U3. Doing the domain DNS now is precisely what lets the Instantly purchase wait and still give ~21 days of warmup before FIRST SEND READY at U6.
- **`ping.ts` is read-only.** — Recreating a permanent `_ping` table that migration `0001` deliberately drops, purely to satisfy a July DoD's wording, would be a schema change made to please a document. Reading `settings`, `leads` and the `transition_lead` RPC proves the same three things and writes nothing.
- **Tests use isolated synthetic fixtures, and prove it by counting.** — A before/after non-fixture row-count assertion turns "this test is non-destructive" from a claim into a check. That is the part worth copying into every future test, more than the fixtures themselves.
- **The approve-path simulation stubs exactly one method.** — `answerCallback` acknowledges a real button press; no button was pressed, so Telegram rejects the synthetic query id. Stubbing that one call keeps the DB writes, the state transition and the operator message live. Stubbing more would have made the test prove less than it appears to.

**Problems hit**
1. **First run of the repaired script crashed on the approve path.** `handleApprove` completed all its DB work, then `answerCallback` threw `Bad Request: query is too old and response timeout expired or query ID is invalid` — the synthetic callback id is not one Telegram issued. The `finally` cleanup ran correctly, so nothing leaked, but the count assertions never printed. Fixed by stubbing `answerCallback` for that one call. Worth knowing: the non-whitelisted rejection path never hits this, because `processTelegramUpdate` returns before `handleCallback` for a non-whitelisted user.
2. **`runDraftStage` cannot be pointed at specific lead ids.** It selects `state = 'drafting'` globally, ordered by `created_at`. Rather than change production code in a docs session, the script **aborts with a non-zero exit if any non-fixture lead is in `drafting`**. Zero are today, so it passes; if that ever stops being true the script refuses to run instead of drafting for real prospects. If a later unit wants true isolation, an optional `leadIds` filter on the stage is the small change to make.
3. **The ✏️ edit and ❌ kill paths are still undemonstrated.** Each needs its own fixture — once a lead is `approved` it cannot transition to `parked` — and edit is a two-step message flow. Step 10 is recorded as *tested locally — approve path*, not as a blanket pass. Backlogged in `09` §5.

**Next action**
- **Send `09-build-plan-v2.md` to the operator for review before Session 4 starts.** Two things need a decision that this session deliberately did not make: whether the U3 purchase trigger should move a unit earlier for DNS slack, and whether to buy the sending domains this week.
- Then **U1 — auth, roles, dashboard shell**, whose migration `0005` also closes the `source_cursors` RLS gap.
- Still outstanding from Session 2 and unrelated to any unit: **put the new `ANTHROPIC_API_KEY` into the Vercel env.** The local fix does nothing for a deployed cron.

---

### 2026-08-23 — Session 2 — Anthropic key replaced, step 7 DoD verified

**Step:** 7 — Anthropic integration + qualify stage
**Status at end:** ✅ DoD passed

**Did**
- Diagnosed the Session 1 `401` with a direct `curl` against the Anthropic API, isolating the fault to the credential rather than to `integrations/anthropic.ts` or the qualify stage.
- Replaced `ANTHROPIC_API_KEY` in `.env.local`.
- Re-ran the step 7 DoD. It passed.
- Updated `06-build-progress.md`: step 7 → ✅, dead-key blocker → resolved, strike-count issue on lead `200c7e06` → resolved, pipeline counts refreshed.

**Files touched**
- `docs/06-build-progress.md` — step 7 row, §1 Anthropic row, two §6 rows, pipeline snapshot, §8
- `docs/07-build-log.md` — this entry

No code changed.

**Verification**

```
$ pnpm tsx scripts/test-qualify.ts --limit 1
=== 3/3 PASS ===
Tokens: 2520 total | Est. cost: $0.0093 total
```
Result: **pass** — step 7 DoD

Lead `200c7e06` (Jimmy Stt, Realty ONE Group Prime, `myrealtyonegroup.com`) was **parked with a `disqualify_reason`**: the site returned 404, so there was no evidence, so no `problem_hypothesis` was produced. That is the evidence-required rule doing its job, not a miss. A parked lead with a stated reason is the correct outcome for a company we cannot see.

**Decisions**
- **Diagnose the credential with `curl` before touching the code.** — A `401` from an SDK wrapper could be the wrapper, the env loading, or the key. One curl separates the three in ten seconds and stops you rewriting a working integration.

**Correction to Session 1**
- Session 1 recorded the failing assertion in `test-qualify.ts` as a fail without questioning it, and separately noted the stage's 3-strike path had behaved correctly. Worth stating plainly now that both readings were right and neither was a script defect: **`FAIL: lead 200c7e06 not left in qualifying` was a true failure.** The `401` meant no qualification was written, so the lead really was still sitting in `qualifying` at the end of the run — exactly what the assertion exists to catch. The script was correct, the stage's error handling was correct, and the credential was the only thing broken. Nothing in `test-qualify.ts` needs changing.

**Problems hit**
- None new. The one carried item is that the replacement key is in `.env.local` only — **Vercel's env still holds the dead key**, so anything deployed will keep returning `401`. Logged in `06-build-progress.md` §1 and §6.

**Next action**
- **Put the new `ANTHROPIC_API_KEY` into the Vercel project env.** The local fix does nothing for a deployed cron.
- Then `STEP-11-RUNBOOK.md` Day 0 — two sending domains, Instantly Hypergrowth, four mailboxes, MillionVerifier credits. That starts the 14-day warmup clock, and step 11 cannot be tested until it finishes.
- Steps 5, 6, 9 and 10 remain 🟨 built-but-unverified. Steps 5 and 6 clear cheaply once you are willing to spend Apollo and Apify credits; step 10 needs the destructive reset block in `scripts/test-draft.ts` fixed first (`06-build-progress.md` §6).

---

### 2026-08-23 — Session 1 — Reconcile tracker against repo

**Step:** docs / reconciliation — no features written
**Status at end:** ✅ reconciliation complete · ⛔ engine blocked on an invalid Anthropic key

**Did**
- Inventoried migrations, stages, integrations, routes and scripts against `05-build-plan.md` steps 1–15; rewrote §1, §2, §5, §6, §7 and §8 of `06-build-progress.md` from that evidence.
- Introduced an evidence rule in the tracker: `✅` requires a DoD script that actually passed this session; `🟨` covers "built but not demonstrated". Applying it moved most steps *down*, not up.
- Committed step 10, which was built on 2026-07-13/14 and had never been committed.
- Found and stopped two things before they did damage: a destructive test script, and a dead API key.

**Files touched**
- `docs/06-build-progress.md` — rewritten against repo state
- `docs/07-build-log.md` — this entry
- commit `0e772ab` — step 10 code, unchanged, with DoD status stated in the commit body

**Verification**

```
$ pnpm build
▲ Next.js 16.2.10 (Turbopack)
✓ Compiled successfully in 1982ms
  Running TypeScript ...
  Finished TypeScript in 2.2s ...
✓ Generating static pages using 6 workers (5/5) in 178ms
Route (app)
┌ ○ /
├ ○ /_not-found
└ ƒ /api/webhooks/telegram
```
Result: **pass**

```
$ pnpm tsx scripts/test-validation.ts
PASS: valid qualifier output parses
PASS: qualifier with hypothesis but empty evidence FAILS
PASS: visible_tools with "none_detected" plus other tools FAILS
PASS: qualifier with disqualify_reason and no hypothesis PASSES
PASS: qualifier evidence citing UNAVAILABLE/failed fetch FAILS
PASS: qualifier with unexpected key FAILS (strict)
PASS: writer 130-word body FAILS
PASS: writer 90-word body passes
PASS: canTransition('sourced','contacted') is false
PASS: canTransition('sourced','enriching') is true
PASS: parseOrThrow throws with context string
PASS: valid classifier output parses
PASS: classifier confidence 0.5 with route_to_human false FAILS
PASS: classifier confidence 0.5 with route_to_human true PASSES
PASS: classifier missing route_to_human FAILS
PASS: unsubscribe with suggested_reply null PASSES

All 16 checks passed.
```
Result: **pass**

```
$ pnpm test:source-filters
# tests 9
# suites 3
# pass 9
# fail 0
```
Result: **pass**

```
$ pnpm tsx scripts/show-settings.ts
apify_actor_templates        |   3 | amir | site crawler → playwright: cheerio retur…
cadence_default              |   1 | seed | initial v1 from 04-prompts-and-icp.md
capacity_defaults            |   1 | seed | initial v1 from 04-prompts-and-icp.md
compliance_footer            |   2 | amir | signature block format for CAN-SPAM
cta_variants                 |   2 | amir | natural human CTA questions; no reply-ke…
icp_rubric                   |   1 | seed | initial v1 from 04-prompts-and-icp.md
proof_points                 |   1 | amir | v1: us-realestate null; lt-events verifi…
qualifier_prompt             |   4 | amir | contradiction rule: discard contested ev…
reply_classifier_prompt      |   1 | seed | initial v1 from 04-prompts-and-icp.md
segments                     |   3 | amir | v3: expand exclude_keywords, drop presid…
send_windows                 |   1 | seed | initial v1 from 04-prompts-and-icp.md
writer_prompt_email          |   7 | amir | human CTA rule; no reply-with-keyword la…
writer_prompt_linkedin       |   1 | seed | initial v1 from 04-prompts-and-icp.md
```
Result: **pass** — and this is the proof migrations are actually applied, not just that `.sql` files exist.

```
$ pnpm tsx scripts/test-state.ts
PASS: legal hop sourced → enriching updates state — state=enriching
PASS: sourced → enriching wrote one lead_events row with from/to — count=1
PASS: enriched event detail contains from/to
PASS: legal hop enriching → qualifying updates state — state=qualifying
PASS: total lead_events matches successful transitions — expected=2
PASS: illegal qualifying → sent throws IllegalTransitionError
PASS: illegal jump leaves leads.state unchanged — qualifying vs qualifying
PASS: illegal jump writes no lead_events row — 2 vs 2
PASS: stale transition throws TransitionError — stale transition: lead … is in
      state qualifying, caller expected sourced
PASS: next_action_at set when passed
PASS: next_action_at null when not passed — null
Cleanup: removed test lead, company, and related rows.

All 11 checks passed.
```
Result: **pass** — step 4 DoD

```
$ pnpm tsx scripts/test-settings.ts
PASS: getActiveSetting('icp_rubric') returns v1 — got v1
PASS: writeNewVersion creates v2 active — got v2
PASS: v1 still exists with active=false
PASS: getActiveSetting returns v2 after write (cache cleared) — got v2
PASS: writeNewVersion throws on empty change_note
PASS: getActiveSetting('does-not-exist') throws
PASS: exactly one active row per key — count=1
PASS: cleanup restored v1 active — got v1

All 8 checks passed.
```
Result: **pass** — step 3 DoD. `icp_rubric` confirmed back on v1 by a follow-up `show-settings.ts` before anything else ran. Side effect worth knowing: cleanup bumps `icp_rubric.updated_at` even though the content is untouched.

```
$ pnpm tsx scripts/test-qualify.ts --limit 1
PASS: select most recent NON-ERROR payload per source (error does not shadow success)
Picking up to 1 leads in qualifying (1 available)

[qualify] lead 200c7e06-… qualify_failed attempt 1/3, retry at 2026-08-23T15:06:00Z

--- Stage summary ---
{ "leads_picked": 1, "qualified": 0, "parked_disqualified": 0,
  "parked_low_score": 0, "failed": 1, "avg_fit_score": null,
  "tokens_used": 0, "est_cost_usd": 0 }

── Jimmy Stt | Real Estate Broker | Realty ONE Group Prime (myrealtyonegroup.com)
   (no qualification row)

FAIL: lead 200c7e06 not left in qualifying — state=qualifying
PASS: negative test: blank evidence rejected by qualifierOutputSchema

=== 2/3 PASS, 1 FAIL ===
```
Result: **fail** — root cause from `lead_events`:
```
"event": "qualify_failed",
"detail": { "attempt": 1, "error": "Anthropic API error (401):
  {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",
  \"message\":\"API key is invalid.\"},\"request_id\":null}" }
```

**Not run (cost / safety gate)**
- `test-enrich.ts` — real Apify actor spend
- `test-verify.ts` — Apollo **reveal credits** + MillionVerifier credits
- `test-source.ts` — Apollo search quota
- `test-draft.ts` — withheld on safety grounds, see Problems
- `draft-target-leads.ts`, `telegram-poll.ts` — Anthropic + outbound Telegram

**Decisions**
- **`✅` now requires a passing DoD run, not file existence.** — The tracker drifted for six weeks precisely because "built" and "verified" shared one symbol. Applying the rule moved steps 1, 2, 5, 6, 7, 9 and 10 to `🟨`.
- **Step 10 committed on its own, before the docs commit, with `DoD not verified at commit time` in the body.** — A tracker row that cites a SHA beats one that points at untracked files; but the subject line must not imply the step is proven working.
- **`test-qualify.ts` run at `--limit 1`, not the default 3.** — It permanently transitions real leads. One is enough to prove or disprove the stage.
- **`test-draft.ts` not run at all.** — Its blast radius is real production data, not tokens.

**Problems hit**
1. **The Anthropic key is dead.** `401 authentication_error`, zero tokens billed. Every Claude call in the engine — qualify, draft, classify, digest — is down. This is the single largest finding of the session and it was invisible until a real call was made. Two silver linings: the 3-strike failure path worked exactly as designed (lead held in `qualifying`, `qualify_failed` logged with attempt count and retry time, nothing guessed its way forward), and the cost was zero.
2. **`scripts/test-draft.ts` destroys real data.** Lines 91–103, before drafting anything, select the `limit * 2` oldest leads in `pending_approval`/`parked`, `DELETE` their `touches` rows, and force-write `leads.state = 'drafting'` **directly on the table**. That bypasses `lib/state.ts` — a hard rule — and writes no `lead_events`, so the reversal of a real parking decision leaves no trace. At the default `--limit 3` against the current DB that is 6 leads and potentially all 4 existing touch rows. Not run. Filed in `06-build-progress.md` §6.
3. **Step 10 had never been committed.** ~4,000 lines across `stages/draft/`, `telegram/handler.ts`, `integrations/telegram*.ts`, `sequences/`, the webhook route, plus edits to `settings/core.ts`, `seed-content.ts`, `validation/jsonb.ts`, living only in the working tree since 14 July. One `git checkout` would have erased six weeks of work.
4. **`scripts/ping.ts` does not exist**, yet `CLAUDE.md` and step 1's DoD both instruct you to run it. Flagged, not fixed — reconcile-only scope.
5. **Doc drift found, beyond the tracker:** docs 01–05 say "NeverBounce" but the code is MillionVerifier; `02-database-schema.md` has no `source_cursors` even though migration `0004` creates it.
6. **`TELEGRAM_WEBHOOK_SECRET` is unset**, so `/api/webhooks/telegram` 500s on every request. Approvals depend on `scripts/telegram-poll.ts`.
7. **The old settings table in §7 was badly wrong** — it listed all keys at v1/2026-07-08. Nine keys had moved (writer at v7, qualifier at v4, segments and apify templates at v3) and four keys were missing from the table entirely.

**Contradictions with the docs**
- Handoff said steps 1–10 built and verified. Repo agrees on *built*; **nothing supports *verified*** for 1, 2, 5, 6, 9, 10, and step 7 actively fails. Repo wins, tracker updated.
- Tracker said all steps ⬜ not started. Wrong in the other direction.
- Step 11's zyndix.com send guard is referenced in `CLAUDE.md` as if it exists. It does not — it ships with `stages/send.ts`, which is unwritten.

**Next action**
- **Replace `ANTHROPIC_API_KEY`** in `.env.local` and Vercel, then re-run `pnpm tsx scripts/test-qualify.ts --limit 1`. Nothing else in the engine is worth touching until that returns a qualification row. Lead `200c7e06` is at strike 1 of 3 — do not re-run qualify against it before the key is fixed.
- Then, independently of the key: `STEP-11-RUNBOOK.md` Day 0 (two sending domains, Instantly Hypergrowth, four mailboxes, MillionVerifier credits) starts the 14-day warmup clock, which runs regardless of anything else.

---

### 2026-08-23 — Session 0 — Reconciliation and Step 11 unblock

**Step:** docs / planning
**Status at end:** 🟨 in progress

**Did**
- Reviewed all six planning docs against the 31 July master handoff.
- Found the tracker in `06-build-progress.md` is **stale**: it shows every step as ⬜ not started, but the handoff records steps 1–10 as built and verified, and the backlog in `05-build-plan.md` contains real operational findings (Lee & Associates parked out-of-ICP, Stephan Group scored 52 against a threshold of 50, `fantasticfrank.co` returned no pages to `website-content-crawler` in cheerio mode) that could only come from live runs.
- Confirmed the actual blocker: **Step 11 is a purchase + DNS + 14-day warmup task, not a coding task.** Everything upstream is built and idle.
- Wrote `STEP-11-RUNBOOK.md`.
- Established this log file and the session discipline above.

**Files touched**
- `docs/07-build-log.md` — created
- `docs/STEP-11-RUNBOOK.md` — created

**Verification**
Not applicable — no code changed this session.

**Decisions**
- **Build moves from Cursor to Claude Code.** The remaining steps are doc-driven with script-based DoDs (`pnpm tsx scripts/test-*.ts`); Claude Code closes the run-read-fix loop itself instead of routing every result through a human. Cursor stays available for single-file edits.
- **Runbook before v2 architecture.** Warmup is a calendar clock. Buying domains starts a 14-day timer that runs regardless of what else is happening; the v2 spec gets written inside that window at zero schedule cost.
- **LinkedIn senders are a settings key, not code.** New settings key `linkedin_senders` — array of `{name, linkedin_url, account_id, active}` with per-campaign selection. Default active: Amir + Ingrida; operator toggles either off per campaign. Reason: sender choice is a judgement call that changes per segment and per week, and hardcoding it would mean a deploy to change who sends.
- **Instantly Hypergrowth over Growth.** Growth covers the real volume; Hypergrowth buys support and headroom. Budget is not the binding constraint here — time is.
- **API keys stay in Vercel env vars.** Dashboard will show key *status* (present / valid / last verified / credits remaining) with a per-service test button. It will not store or edit credential values. Reason: a dashboard auth bug that exposes stored service-role keys is an unrecoverable failure; read-only status gives the visibility without the blast radius.

**Problems hit**
- Doc drift between the tracker and reality. Fixing this is the first job of Session 1 — the tracker must be corrected against the repo before any new code is written, or every future estimate starts from a false baseline.

**Next action**
- Execute `STEP-11-RUNBOOK.md` Day 0: buy two sending domains, buy Instantly Hypergrowth, buy four mailboxes, buy MillionVerifier credits.
- Then Session 1 (Claude Code): reconcile `06-build-progress.md` against the actual repo state — read `src/lib/stages/`, `src/lib/integrations/` and `supabase/migrations/`, mark each of steps 1–10 with what genuinely exists, and log the result here.
