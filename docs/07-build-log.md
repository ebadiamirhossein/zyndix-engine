# Zyndix Outbound Engine — Build Log

**File:** `07-build-log.md` · **Started:** 2026-08-23
**Type:** append-only session journal. Newest entry at the top.

**Relationship to the other docs:**
- `05-build-plan.md` — the contract. What we agreed to build, in order. Rarely changes.
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
