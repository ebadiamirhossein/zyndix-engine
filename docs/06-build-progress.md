# Zyndix Engine — Build Progress

**File:** `06-build-progress.md` · **Started:** 2026-07-08 · **Last reconciled:** 2026-09-25 (Session 10)
**Tracks:** `09-build-plan-v2.md`, which implements `08-complete-build-brief.md`.

**Status vocabulary** (`CLAUDE.md`, never collapsed):

| Status | Means |
|---|---|
| **not started** | no implementation exists |
| **implemented** | code exists and looks complete; its DoD has not been demonstrated |
| **tested locally** | its DoD script was actually run and passed, output in `07-build-log.md` |
| **verified with provider** | exercised against the real third-party service, separately reported |
| **active in production** | running against real prospects |

"The file exists" is never better than **implemented**. A mocked integration is never **verified with provider**. Where this file and any handoff disagree, **the repo wins**.

---

## 1. Prerequisites (outside the repo)

Filled from `.env.local` **key presence only** — no value was read, printed or recorded.

| Item | Status | Needed by | Notes |
|---|---|---|---|
| Supabase project `zyndix-engine` | ✅ ready | — | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` present. Migrations verified applied by `scripts/ping.ts` 2026-09-21 |
| Anthropic API key | ✅ ready | — | Replaced 2026-08-23 after a `401`. Verified live. **Vercel env still holds the dead key** |
| Apollo API key + credits | 🟨 present, unverified | U15 | Plan/tier and remaining credits not confirmed |
| Apify account + token | 🟨 present, unverified | U15 | Balance not confirmed |
| MillionVerifier key + credits | ✅ ready (test volume) | U5 | `MILLIONVERIFIER_API_KEY` present. **495 free credits** (operator-reported 2026-09-25) — enough for testing, **top up before volume**. `NEVERBOUNCE_API_KEY` absent and superseded |
| Telegram bot + user IDs | ✅ ready | — | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` present; approve path exercised 2026-09-21 |
| **Two sending domains** | ✅ **bought 2026-09-21** | U5 | `zyndixhq.com` and `getzyndix.com`. 301 → `zyndix.com` live on both. These are U5's allowed-sender list. `STEP-11-RUNBOOK.md` §A.1 |
| DNS — `zyndixhq.com` (Google Workspace) | ✅ verified | U5 | `dig` 2026-09-25: MX `smtp.google.com`, SPF `include:_spf.google.com ~all`, DKIM `google._domainkey` published, DMARC `p=none`. Operator reports SPF/DKIM/DMARC verified in Workspace. `07` Session 10 |
| DNS — `getzyndix.com` (Microsoft 365) | 🟨 **DMARC missing** | U5 | `dig` 2026-09-25: MX `getzyndix-com.mail.protection.outlook.com`, SPF `include:spf.protection.outlook.com -all`, DKIM `selector1`/`selector2._domainkey` CNAMEs **resolve** to M365 keys. **`_dmarc.getzyndix.com` is NXDOMAIN** (checked on 1.1.1.1 and 8.8.8.8) — the likely cause of mail-tester's "not fully authenticated". Operator: add the DMARC TXT (runbook §B.0), then re-test |
| Tracking CNAME (`track.`) | ⬜ not set on either domain | U6 | `dig` 2026-09-25: no `track` CNAME on either domain. Runbook §B.4 |
| **Instantly Growth + 4 mailboxes** | ✅ **live, warming** | U4 | Bought 2026-09-24 (**Growth**, not Hypergrowth — §5). Live read 2026-09-25 (`live-instantly.ts --all`): workspace `Zyndix`, `plan_id pid_g_v2`, **4 accounts, all status active / warmup active / setup_pending false / warmup score 100**, **0 campaigns**. Warmup started 2026-09-24 19:31–20:52 UTC (all four). Each account shows `daily_limit=30` — harmless with no campaigns, but **not** the runbook's "0 until U6"; operator to confirm the intended value |
| Mailboxes | ✅ connected | U5 | `zyndixhq.com`: separate **Google Workspace** tenant, `amir@` + `ingrida@`, both licensed. `getzyndix.com`: separate **Microsoft 365** tenant, Business Basic, 2 licences (admin account unlicensed), `amir@` + `ingrida@`. **Same local parts on both domains** → one `send_account` per lead for the whole sequence (§6) |
| `INSTANTLY_API_KEY` | ✅ **verified** | U4 | Present in `.env.local`. Read scopes proven live 2026-09-25 (workspaces, accounts, campaigns, webhook event types). Write scopes (`leads:create`, `leads:delete`, `campaigns:update`, `block_list_entries:create`) **not exercised** — first used in U5/U6 |
| Mailboxes pass mail-tester ≥9/10 | ✅ score gate met · 🟨 getzyndix auth open | U5 | All four scored **9.6/10** (operator-reported). `zyndixhq.com` mailboxes: "properly authenticated". **`getzyndix.com` mailboxes: "You're not fully authenticated"** — DKIM had been enabled minutes before the test, and DMARC is absent (above). **Re-test pending; not passed.** `send_accounts` still has 0 rows (U5 creates them) |
| `TELEGRAM_WEBHOOK_SECRET` | ⬜ | U9 | Unset → `/api/webhooks/telegram` 500s on every request. Approvals run via `scripts/telegram-poll.ts` |
| `DASHBOARD_ALLOWED_EMAILS` | ✅ ready (local) | U1 | Present and non-empty in `.env.local`. Gates who may sign in and the role each is provisioned with (`email:role`; bare email = `viewer`). Vercel env **not verified** from inside the repo |
| `SUPABASE_ANON_KEY` | ✅ ready (local) | U1 | Present and non-empty in `.env.local`. Anon key, **not** service-role, and deliberately not `NEXT_PUBLIC_`. Vercel env **not verified** from inside the repo |
| Supabase Auth email provider + redirect URL | ✅ ready (localhost) | U1 | Magic-link round trip completed by the operator on localhost, 2026-09-24. Whether the production callback URL is allow-listed is **not verified** — check before deploy |
| Migration `0005_app_users_roles.sql` applied | ✅ applied | U1 | Proven by `test-u1-auth.ts`: `app_users` readable, check constraint rejects a bad role (`23514`), `source_cursors` trigger fires |
| Migrations `0006_jobs.sql` + `0006b_claim_jobs_rpc.sql` applied | ✅ applied 2026-09-24 | U2 | Applied by the operator in the SQL editor. `jobs.relrowsecurity = t`; `claim_jobs` executable by `postgres`, `service_role` and `supabase_admin` only (operator-reported). Exercised end to end by `test-u2-jobs.ts` |
| Migrations `0007_capacity_counters.sql` + `0007b_reserve_capacity.sql` applied | ✅ applied 2026-09-24 | U3 | Applied by the operator in the SQL editor. `capacity_ledger` and `capacity_reservations` both `relrowsecurity = true`; `reserve_capacity` and `settle_capacity` executable by `postgres` and `service_role` only (operator-reported). Exercised end to end by `test-u3-scheduler.ts` |
| Calendly webhook signing key | ⬜ | U8 | `CALENDLY_WEBHOOK_SIGNING_KEY` absent |
| Attio API key | ⬜ | U19 | Deliberately deferred 2026-07-13; nothing before U19 needs it |
| Heyreach account | ⬜ | U18 | External execution stays **off**; adapter completes without it |
| Embeddings provider | ⬜ open decision | U12 | Anthropic has no embeddings endpoint. FTS ships first and stays the labeled fallback |
| GitHub repo + Vercel linked | 🟨 | U23 | git repo live; Vercel link not verifiable from inside the repo |

---

## 2. Unit tracker — `09-build-plan-v2.md`

Units run in execution order. Phase 4 precedes Phase 2 by operator decision (§5, 2026-09-21).

### Phase 1 — Reconcile and repair *(4 sessions)*

| Unit | Name | Status | Evidence |
|---|---|---|---|
| — | Repair + adopt brief *(Session 3)* | ✅ **tested locally** | `test-draft.ts` rewritten against fixtures, 32/32 pass, non-fixture counts identical. `ping.ts` added, 3/3 pass. Docs realigned |
| U1 | Auth, roles, dashboard shell | ✅ **tested locally** | `scripts/test-u1-auth.ts --base-url http://localhost:3000` → **48/48**, non-fixture row counts unchanged (2026-09-24, `07` Session 6). Magic-link sign-in end to end as `admin`; all ten areas render (operator-verified) |
| U2 | Durable job system 🛒 | ✅ **tested locally** | `pnpm test:jobs` → **63/63** against Supabase, all four `09` §U2 DoD items, non-fixture row counts and `jobs` count unchanged (2026-09-24, `07` Session 8). No provider, so this is the highest status U2 can reach. The 🛒 purchase is operator-owned and was not a code blocker |

### Phase 4 (early) — Campaign execution *(18 sessions, incl. UD)*

| Unit | Name | Status | Evidence |
|---|---|---|---|
| U3 | Scheduler: ledger + send windows | ✅ **tested locally** | `pnpm test:scheduler` → **80/80** against Supabase: 30 concurrent reservations at quota 15 → exactly 15 `ok` / 15 `quota_exhausted`, `reserved = 15` (3 rounds); release decrements; windows table incl. both DoD cases, 3 DST dates, ±17 min jitter over 1000 draws; non-fixture counts unchanged (2026-09-24, `07` Session 9). No provider, so this is the highest status U3 can reach |
| U4 | Instantly adapter | ✅ **tested locally** · **read paths verified with provider** · write paths mocked only | `pnpm test:instantly` → **63/63** (fetch mocked, synthetic fixtures): every `09` §U4 DoD case plus the full three-way taxonomy. `live-instantly.ts --all` against the real account 2026-09-25: workspace + **4 accounts**, 0 campaigns, warmup analytics, webhook event types — every response parsed by the fixture schemas, `secret material in output: none` (`07` Session 10). **Enroll / pause / activate / delete / block-list have never touched Instantly** — they reach *verified* only in U6 Part 2's live drill |
| U5 | Send stage, preflight, guards | ⬜ not started | **The `zyndix.com` guard does not exist yet** — it arrives here. Also carries **sender pinning** (one `send_account` per lead per sequence, `sender_mismatch`), added 2026-09-25 |
| U6 | Webhooks, reply freeze, suppression 🚩 | ⬜ not started | 🚩 **FIRST SEND READY.** `instantlyWebhookSchema` written, unconsumed |
| U7 | Reply classifier + routing | ⬜ not started | `reply_classifier_prompt` v1 seeded; schema written; no stage consumes it |
| **UD** | **Apply design system** 🎨 | ⬜ not started | Added 2026-09-21. U1 ships the shell unstyled; the system is authored in Claude Design. Sits before U8, the first unit that renders real data |
| U8 | Calendly, meetings, booking stop | ⬜ not started | route is a `.gitkeep` |
| U9 | Orchestrator, crons, pause | ⬜ not started | both cron routes are `.gitkeep`; `lib/auth/cron.ts` exists |

### Phase 2 — Knowledge system *(11 sessions)*

| Unit | Name | Status | Evidence |
|---|---|---|---|
| U10 | Storage, upload, extraction | ⬜ not started | no Storage usage anywhere yet |
| U11 | PDF/DOCX, OCR, review, screening | ⬜ not started | |
| U12 | Search, retrieval, Ask the library | ⬜ not started | embeddings provider undecided |
| U13 | Structured catalog | ⬜ not started | `proof_points` v1 is the only asset store today |

### Phase 3 — Research and matching *(9 sessions)*

| Unit | Name | Status | Evidence |
|---|---|---|---|
| U14 | Campaigns, enrollments, prospect import | ⬜ not started | |
| U15 | Typed evidence model | ⬜ not started | builds on `enrich/core.ts` + `qualify/core.ts` |
| U16 | Matching and recommendations ⭐ | ⬜ not started | ⭐ the brief's central acceptance criterion |
| U17 | Draft rewired to matching, approvals UI | ⬜ not started | |

### Phase 5 — Integrations and commercial workflow *(12 sessions)*

| Unit | Name | Status | Evidence |
|---|---|---|---|
| U18 | Heyreach + manual LinkedIn (OFF) | ⬜ not started | |
| U19 | Attio two-way sync | ⬜ not started | supersedes the deferred step 8 |
| U20 | Inbox, briefs, pipeline, opportunities | ⬜ not started | |
| U21 | Costs, reports, digest, learning | ⬜ not started | |

### Phase 6 — Verification and handoff *(5 sessions)*

| Unit | Name | Status | Evidence |
|---|---|---|---|
| U22 | Dashboard pass, e2e, chaos, red-team | ⬜ not started | |
| U23 | Fresh-project migrations, handoff | ⬜ not started | |

**Live pipeline as of 2026-09-21:** 34 companies · 34 leads — `parked` 19, `qualifying` 10, `pending_approval` 3, `approved` 1, `enriching` 1 · 219 lead_events · 4 touches · **0 send_accounts** · 0 leads have reached `sent`.

---

## 3. Carried-over status of steps 1–10 (`05-build-plan.md`)

The old 15-step plan is superseded by the unit tracker above, but the code those steps produced is real and most units reuse it. Restated honestly in the four-word vocabulary:

| Old step | What exists | Status | Why not higher |
|---|---|---|---|
| 1 Scaffold & foundations | Next 16.2.10, TS strict, `lib/db`, `auth/cron.ts`, `scripts/ping.ts` | **tested locally** | `ping.ts` written and passing 2026-09-21. It is read-only: migration `0001` drops `_ping`, so the original write-a-row DoD is unrunnable by design |
| 2 Migrations | `0000`–`0004`, 17 tables, RLS on 16, `transition_lead` RPC | **implemented** | Applied to the live DB and proven reachable by `ping.ts`, but no per-table insert/read DoD script exists. `source_cursors` lacks RLS — fixed in U1 |
| 3 Settings system | `settings/core.ts` (210), seed content (314) | **tested locally** | `test-settings.ts` 8/8 |
| 4 State machine | `state/core.ts` (122) + `0002` RPC | **tested locally** | `test-state.ts` 11/11 |
| 5 Apollo + source | `apollo.ts` (389), `source/` (559) | **implemented** | `test-source.ts` withheld on Apollo quota. `test:source-filters` 9/9 covers name-guard units only |
| 6 Apify + enrich | `apify.ts` (295), `enrich/core.ts` (540) | **implemented** | `test-enrich.ts` withheld on real actor spend. Templates at v3 (`playwright:adaptive`), **never re-tested against the site that failed** |
| 7 Anthropic + qualify | `anthropic.ts` (167), `qualify/core.ts` (661) | **verified with provider** | `test-qualify.ts --limit 1` 3/3, 2,520 tokens, $0.0093, live API. Lead `200c7e06` correctly parked with a `disqualify_reason` |
| 8 Attio sync | placeholders only | **not started** | Deliberately deferred 2026-07-13. Returns as U19 |
| 9 Verification stage | `millionverifier.ts` (149), `verify/core.ts` (418) | **implemented** | `test-verify.ts` withheld — spends Apollo **reveal** credits plus MillionVerifier credits |
| 10 Writer + Telegram | `draft/core.ts` (542) + `guard.ts` (325), `telegram/handler.ts` (643) | **tested locally — approve path** | `test-draft.ts` 32/32 on 2026-09-21: draft → `pending_approval` → Telegram → ✅ → `approved`. **The ✏️ edit and ❌ kill paths remain undemonstrated** — each needs its own fixture |
| 11 Instantly send | — | **not started** | Becomes U3–U6 |
| 12 Webhooks | `.gitkeep` | **not started** | Becomes U6, U8 |
| 13 Reply classifier | `.gitkeep` | **not started** | Becomes U7 |
| 14 Orchestrator | `.gitkeep` | **not started** | Becomes U9 |
| 15 Dashboard | `.gitkeep` | **not started** | Becomes U1 (shell) + U22 (full pass) |

**Nothing is "active in production".** Zero leads have reached `sent`.

---

## 4. Phase 0 tracker (manual warm outreach — parallel, not optional)

| Item | Status | Notes |
|---|---|---|
| 20 LT target companies listed | ⬜ | |
| Messages 1–5 sent | ⬜ | |
| Messages 6–10 sent | ⬜ | |
| Messages 11–20 sent | ⬜ | |
| Replies / meetings logged | ⬜ | replies: _ · meetings: _ |
| Best 5 promoted into writer prompt | ⬜ | writer is already at v7 from live iteration, so this becomes v8 |
| 4 testimonial requests sent | ⬜ | Fonderis, ScholarCert, PulseConf, Loveko — drafts exist, pending since late July |

This depends on nothing in the build and is the cheapest source of real hypothesis/evidence pairs. It is still the highest-value item that is not code.

---

## 5. Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-07-08 | One orchestrator + stage workers, no agent swarm | determinism, debuggability, cost |
| 2026-07-08 | Supabase = brain, Attio = thin human window | full data ownership; Attio's 3-object cap irrelevant |
| 2026-07-08 | Cron-pull over event/queue architecture | replayable, zero queue infra at v1 volume |
| 2026-07-08 | Telegram over Slack for approvals | mobile speed, free bot API, 2-person team |
| 2026-07-08 | Buy pre-warmed domains; still ramp from 15/day | warmup ≠ immunity |
| 2026-07-08 | Skip Clay, Reply.io, Wappalyzer at v1 | duplication vs own Claude layer; HTML tool-detect covers most of it free |
| 2026-07-08 | Verification mandatory before send | bounce >3% burns inboxes |
| 2026-07-08 | Evidence-required rule enforced at DB level | the anti-generic guarantee |
| 2026-07-08 | Cold sends never from zyndix.com — code guard | domain reputation is unrecoverable |
| 2026-07-08 | Ads conversion module: capture now, upload later | standing instruction: don't jump ahead on ads |
| 2026-07-13 | Step 8 (Attio) deferred | read-only human window; nothing downstream depends on it |
| 2026-07-13 | **MillionVerifier chosen over NeverBounce** | implemented as `integrations/millionverifier.ts` |
| 2026-07-13 | Apify crawler → `playwright:adaptive` | cheerio returned zero pages on JS-rendered sites |
| 2026-08-23 | LinkedIn senders as a `settings` key, not code | sender choice is a per-campaign judgement; hardcoding means a deploy to change who sends |
| 2026-08-23 | Instantly Hypergrowth over Growth | time, not budget, is the binding constraint |
| 2026-08-23 | API keys stay in env vars; dashboard shows status only | a dashboard auth bug exposing stored service-role keys is unrecoverable |
| 2026-08-23 | Telegram long-poll stands in for the webhook | `TELEGRAM_WEBHOOK_SECRET` unset; unblocks approvals without a public URL |
| 2026-08-23 | `✅` requires a passing DoD run, not file existence | the tracker drifted for six weeks because "built" and "verified" shared one symbol |
| **2026-09-21** | **`08-complete-build-brief.md` adopted as scope authority** | It supersedes docs 01–05 wherever they conflict. Docs 01–05 keep a banner saying so rather than being deleted — they remain the record of how existing code was built |
| **2026-09-21** | **Build runs in Claude Code (desktop app), not Cursor** | Decided 2026-08-23, now in force. The remaining DoDs are script-based; Claude Code closes the run-read-fix loop without a human relay |
| **2026-09-21** | **Phase 4 executes before Phase 2** | Every first touch is operator-approved in Telegram and the proof line is operator-written, so the approval gate covers the generic-copy risk. The binding constraint on revenue is that `stages/send.ts` does not exist, not that a library does not exist. First send runs on the existing draft stage with a minimal single-campaign config; U14/U17 migrate it onto campaigns and matching |
| ~~2026-09-21~~ | ~~Sending domains bought now; Instantly bought at U3~~ | **Superseded the same day — see the next row.** The premise (that the domains' DNS could be completed immediately) was wrong |
| **2026-09-21** | **Domains bought; DNS and the Instantly purchase both move to U2** | Domains were bought and 301'd to `zyndix.com`; the rest of their DNS was deferred. That deferral was not optional: **DKIM is generated in Google Workspace Admin, and Workspace is part of the Instantly/mailbox purchase**, so clock A could never have delivered "full DNS". Moving the purchase from U3 (≈ day 11) to U2 (≈ day 7) buys four days, which is what funds the DNS work on purchase day. Warmup goes from ~21 to **~24 days** before FIRST SEND READY at U6 (≈ day 33) |
| **2026-09-21** | **The dashboard ships unstyled; the design system lands at UD** | The design system is being authored in Claude Design, outside the repo. Styling U1's shell in code before it exists would be thrown away. U1 therefore ships plain semantic HTML — no colour, no spacing scale, no components — and new unit **UD** applies the system just before U8, the first unit that renders real data. Styling earlier means styling empty pages; later means restyling |
| **2026-09-21** | **Dashboard roles bootstrap from `DASHBOARD_ALLOWED_EMAILS`, then the DB is authority** | The env gates who may sign in and what role they are *provisioned* with (`email:role`, bare email = `viewer`). After first login `app_users.role` wins and is never overwritten from the env, so changing someone's role is a DB update, not a redeploy. Rejected "first user wins admin" — privilege should not depend on who clicks first |
| **2026-09-21** | **`app_users.role` carries a `check` constraint — the schema's first** | The repo enforces state legality in application code and has no other check constraints. A role is a privilege boundary, so an unrecognised value must not be insertable at all. Recorded as a deliberate exception, not drift |
| **2026-09-21** | **MillionVerifier replaces NeverBounce — docs corrected, not just contradicted** | The 2026-07-13 decision was real but docs 01–05 kept saying "NeverBounce" for two months. They now carry an explicit drift note |
| **2026-09-21** | **Tests use isolated synthetic fixtures, never real prospects** | `test-draft.ts` reset 6 real leads and deleted their touches. Fixtures plus a before/after non-fixture row-count assertion make that class of bug detectable rather than silent |
| **2026-09-24** | **`jobs.attempts` increments at claim, not at failure** | A handler that crashes its worker never reaches `fail()`. Counting at claim means a crash still spends an attempt, and `claim_jobs()` dead-letters an expired lease on its final attempt (`lease_expired_after_final_attempt`) instead of re-claiming a poison job forever |
| **2026-09-24** | **Every job write after claim is lease-fenced** (`id + state='leased' + lease_owner + attempts`) | A worker that overran its lease and was superseded must not overwrite the new holder. Its late `complete()`/`fail()` returns `lease_lost` and changes nothing |
| **2026-09-24** | **The worker claims one job at a time** | A budget stop can then never strand a job that was leased but not started. One RPC per job is negligible at this volume; revisit only if claim overhead shows up in a cron's budget |
| **2026-09-24** | **`jobs.state` carries a check constraint** — the schema's second, after `app_users.role` | An unrecognised state is invisible to every claimer: the job would be silently lost. Same reasoning as the role constraint |
| **2026-09-24** | **New `security definer` functions pin `search_path` and revoke PUBLIC execute** | `claim_jobs` does both. `0002`'s `transition_lead` does neither — still in the `09` §5 backlog, not fixed here |
| **2026-09-24** | **Send-window tier rule: priority lookahead** (operator decision, Session 9) | `09` §U3's two DoD window cases conflict under a plain earliest-window rule: from Sun 23:00 and from Fri 16:30 the next two windows are the same (Mon 13:30 secondary, Tue 08:30 priority), yet one case expects Tuesday and the other Monday. Rule adopted: take the next priority window if it opens within `priority_lookahead_hours` (default **48**), else the earliest window of either tier. The field is optional on `send_windows`, so v1 still parses and no settings row was written; changing it is a new settings version |
| **2026-09-24** | **Capacity reservations are rows (`capacity_reservations`), not just counters** | `09` §U3 names only the four counters. But U2 jobs can be re-claimed and re-run, and a counters-only ledger would double-decrement on a retried release. Every counter change is a state transition on a reservation row inside `reserve_capacity()`/`settle_capacity()`, so it applies at most once; repeating a reached state returns `already`. Idempotency keys make a re-run reservation return the first one |
| **2026-09-24** | **An uncertain send keeps its capacity held until reconciled** | A timeout after possible acceptance may have sent the message. It keeps counting in `reserved` until reconcile says `sent` (→ `used`, `reconciled`) or `not_sent` (→ freed, `reconciled`). Full table in `0007`'s header |
| **2026-09-24** | **A day's quota only goes down; it is counted per sender per UTC day** | The first reservation sets the day's quota from the ramp; a later lower quota lowers it, a higher one does not raise it. The ledger date is the UTC date of the send instant (CLAUDE.md: timestamps in UTC) |
| **2026-09-24** | **The ramp anchors on new `send_accounts.ramp_started_on`; `daily_quota` is not used** | The ramp (15→30, +5 every 4 days) needs a start date and `send_accounts` had none. Null = not started → `rampQuota()` returns null, never 0. `daily_quota` (default 0 in `0001`) is ambiguous and superseded by the ramp |
| **2026-09-24** | **Work directly on `main`: no feature branches, no PRs** | Operator decision after U2. Units U1 and U2 each went through a branch and a PR (#1, #2), and for a single operator that is a round trip with no reviewer on the other end. The safety net is unchanged: every unit still ends with a passing DoD, real output in `07`, one commit and an operator-run `git push origin main`. Supersedes the per-unit `feat/*` branches used for U1 and U2. `CLAUDE.md` §Session discipline updated |
| **2026-09-25** | **Instantly Growth, not Hypergrowth** — supersedes the 2026-08-23 row | Operator purchase, 2026-09-24. Live `plan_id pid_g_v2`. The API and the webhook event-types endpoint are reachable on Growth (proven live). Whether Growth can **create** webhooks is unproven until U6 — creating one is a write |
| **2026-09-25** | **Two sending tenants: Google Workspace (`zyndixhq.com`) and Microsoft 365 (`getzyndix.com`)** | Provider diversity: one tenant's reputation or outage does not take down all sending. Mailboxes are `amir@` + `ingrida@` on both — this supersedes the runbook's `a.ebadi@` / `i.silobrit@` plan |
| **2026-09-25** | **A lead keeps one `send_account` for its whole sequence — never rotate mid-sequence** | The same display names (`amir@`, `ingrida@`) exist on both domains, so a follow-up from the other domain looks like a different sender with the same name. Instantly has **no per-lead sending-account field**, so U5 pins it structurally: one Instantly campaign per `send_account` plus an engine-side lead→`send_account` binding and a `sender_mismatch` preflight refusal (`09` §U5) |
| **2026-09-25** | **Instantly mutations: any 5xx is an uncertain outcome, not retryable** | `09` §U4 said "429/5xx → retryable". A 5xx after a POST may have been committed server-side; treating it as retryable permits exactly the resend §10 forbids. Reads keep 5xx → retryable (once). 429 stays retryable everywhere — it is rejected before processing. Connect-phase failures (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT`) are retryable even for mutations — nothing reached the server |
| **2026-09-25** | **Enrollment uses `POST /api/v2/leads/add` with one lead, `skip_if_in_workspace` on by default** | Instantly has **no idempotency-key header**. The bulk endpoint is the only create that reports skips explicitly (`leads_uploaded`, `skipped_count`, `in_blocklist`…), and the skip flags make a replayed enrollment a no-op instead of a duplicate. Inconsistent counts on a 200 are treated as uncertain |
| **2026-09-25** | **The adapter never retries a mutation; `accountHealth` takes its score threshold from the caller** | Retrying writes belongs to the U2 job system, where attempts are counted and fenced. The warmup-score threshold is policy, so it comes from settings in U5, not a constant in the adapter; without one the score is reported, not judged, and a missing score is `unknown`, never 0 |

---

## 6. Issues / blockers log

| Date | Issue | Status | Resolution |
|---|---|---|---|
| 2026-08-23 | **`scripts/test-draft.ts` destroys real data.** Selected the oldest real `pending_approval`/`parked` leads, `DELETE`d their touches and force-wrote `leads.state` directly, bypassing `lib/state.ts` and writing no `lead_events` | ✅ **resolved 2026-09-21** | Rewritten against synthetic fixtures with scoped cleanup, all transitions through `lib/state.ts`, an abort guard if any non-fixture lead is in `drafting`, and a before/after non-fixture row-count assertion. 32/32 pass; counts identical |
| 2026-08-23 | `scripts/ping.ts` does not exist, but `CLAUDE.md` and step 1's DoD both name it | ✅ **resolved 2026-09-21** | Written as a **read-only** round-trip. Migration `0001` ends with `drop table if exists _ping`, so the original write-a-row DoD was unrunnable against the real schema |
| 2026-08-23 | `ANTHROPIC_API_KEY` returned `401` | ✅ resolved 2026-08-23 | Key replaced in `.env.local`. **Still to do: replace it in the Vercel env** — the fix is local only |
| 2026-09-21 | **`source_cursors` (migration `0004`) has no RLS and no `updated_at` trigger**, unlike all 16 tables in `0001`. Not exploitable today — `anon`/`authenticated` are ungranted — but it breaks the pattern | ✅ **resolved 2026-09-24** | `0005` applied. `trg_updated_at` proven firing by `test-u1-auth.ts` group 4b. RLS proven by the `relrowsecurity` query in the migration's trailer, run by the operator 2026-09-24: `app_users`, `leads` and `source_cursors` all `true` (`07` Session 7) |
| 2026-09-21 | `STEP-11-RUNBOOK.md` claimed the `zyndix.com` guard was "already enforced by a code guard in `stages/send.ts`". No such file exists | ✅ resolved 2026-09-21 | Runbook corrected. The guard arrives at **U5** and that unit's DoD verifies it |
| 2026-08-23 | `TELEGRAM_WEBHOOK_SECRET` unset → `/api/webhooks/telegram` 500s | 🟨 open | Scheduled into **U9**. `telegram-poll.ts` covers approvals until then |
| 2026-08-23 | `source_cursors` not documented in `02-database-schema.md` | 🟨 open | Docs 01–05 now carry a drift banner naming it. Full reconciliation is **U23** |
| 2026-07-13 | **JS-rendered sites returned no pages to the crawler.** `fantasticfrank.co` returned zero pages in cheerio mode | 🟨 mitigated, unverified | Templates bumped to v3 with `crawlerType: playwright:adaptive`. **Never re-tested against that site** — do not assume any site is uncrawlable |
| 2026-07-13 | **Qualification rate ≈ 20%** (1 of 5), implying ~125 leads/week sourced to hit 25 contacts/week | 🟨 open | Monitor. Do **not** widen the ICP to close the gap — a vaguer ICP means a vaguer message |
| 2026-07-13 | **`QUALIFY_MIN_SCORE` unsettled.** Currently 50; Stephan Group scored 52, so 60 would have qualified nobody | 🟨 open | Needs more scored leads. Do not change it to raise throughput |
| 2026-09-21 | `test-draft.ts` ✏️ edit and ❌ kill paths undemonstrated | 🟨 open | Each needs its own fixture — an approved lead cannot transition to `parked`. Backlogged in `09` §5 |
| 2026-09-21 | **U1's DoD is partly blocked on operator steps.** `app_users` store checks need `0005` applied; the HTTP checks need `SUPABASE_ANON_KEY`, `DASHBOARD_ALLOWED_EMAILS` and the Supabase email provider | ✅ **resolved 2026-09-24** | All four steps done. 48/48 |
| 2026-09-24 | **Dashboard auth is proven on localhost only.** `SUPABASE_ANON_KEY` and `DASHBOARD_ALLOWED_EMAILS` are confirmed in `.env.local`; their presence in the Vercel env, and the production callback URL in Supabase's redirect allow-list, are not verifiable from inside the repo | 🟨 open | Check both before any dashboard deploy. Same class of gap as the Anthropic key still dead in Vercel |
| 2026-09-21 | **`pnpm lint` fails on `main` — 17 errors, 4 warnings**, all `no-explicit-any` in pre-existing `scripts/*.ts` plus unused-var warnings in `src/lib`. Identical counts before and after U1 | 🟨 open, pre-existing | Not touched by U1 (scope discipline). `pnpm build` and `tsc --noEmit` are clean. Worth a dedicated cleanup session — backlogged in `09` §5 |
| 2026-09-21 | **`0002_transition_lead.sql` is `security definer` with no `set search_path`.** Supabase's linter flags this as `function_search_path_mutable` | 🟨 open | Out of U1's scope; fixing it means a new migration replacing the function. Backlogged in `09` §5 |
| 2026-09-25 | **Same mailbox names on both sending domains** (`amir@`, `ingrida@` on `zyndixhq.com` and `getzyndix.com`) → a lead must keep one `send_account` for its whole sequence, never rotating mid-sequence | 🟨 open — **U5 requirement** | Added to `09` §U5 scope and DoD. Instantly cannot pin a sender per lead, so U5 enforces it with one Instantly campaign per `send_account` and a `leads`→`send_account` binding |
| 2026-09-25 | **`getzyndix.com` "You're not fully authenticated" on mail-tester**, despite 9.6/10 on both mailboxes. DKIM had been enabled minutes before the test. `dig`: both DKIM selectors resolve, but **`_dmarc.getzyndix.com` is NXDOMAIN** | 🟨 open — operator | Add a DMARC TXT on `getzyndix.com` (same policy as `zyndixhq.com`, runbook §B.0), then re-run mail-tester on both getzyndix mailboxes. Not passed until the re-test says authenticated |
| 2026-09-25 | **Instantly accounts carry `daily_limit=30`**; the runbook says the send limit stays 0 until U6. Operator reported "campaign send limit at minimum" | 🟨 open — operator to confirm | No campaigns exist, so nothing can send today. Changing it is a write to live Instantly settings — not done. U5's own ledger quota (15→30 ramp) is the engine-side cap regardless |
| 2026-09-25 | **Webhooks on Growth are unproven.** A third-party source says webhooks need Hypergrowth; the official docs name no tier. The event-types endpoint answered on Growth (18 types). Creating a webhook is a write and was not attempted | 🟨 open — **check at the start of U6** | If creation is refused on Growth, U6 needs either a plan change or a polling fallback. Also: the live event list differs from both the spec and the guide (has `custom_label_any_positive/negative`; no `auto_reply_received`, no `lead_no_show`) — U6 must use the live list |
| 2026-09-25 | No tracking CNAME (`track.`) on either sending domain | 🟨 open — operator, before U6 | Runbook §B.4. Opens are diagnostic only (brief §8), so this is not a U5 blocker |
| 2026-09-21 | **`@supabase/ssr` required a `supabase-js` bump**, 2.110.1 → 2.116.0, to satisfy its `^2.114.0` peer | ✅ resolved 2026-09-21 | Minor bump inside the same major. `tsc`, `pnpm build`, `test-validation` (16/16) and `test-state` re-run clean afterwards |

---

## 7. Settings version log (mirror of DB — verified live 2026-08-23)

| Key | Active version | Last change | Note |
|---|---|---|---|
| icp_rubric | v1 | 2026-07-13 | seed content unchanged |
| segments | v3 | 2026-07-13 | expanded `exclude_keywords`, dropped president title; `lt-events` present, `active: false` |
| qualifier_prompt | v4 | 2026-07-13 | contradiction rule: discard contested evidence |
| writer_prompt_email | v7 | 2026-07-13 | human CTA rule; no reply-with-keyword language |
| writer_prompt_linkedin | v1 | 2026-07-13 | seed; consumed by nothing until U18 |
| reply_classifier_prompt | v1 | 2026-07-13 | seed; consumed by nothing until U7 |
| cadence_default | v1 | 2026-07-13 | 0/3/7/14, stop on reply |
| capacity_defaults | v1 | 2026-07-13 | 15→30/day ramp; auto-pause at 3% bounce / 1 complaint. `email_inbox` read by `rampQuota()` (U3); the send stage (U5) is the first runtime caller |
| send_windows | v1 | 2026-07-13 | Tue–Thu priority, 08:30–11:00 local. Read by `nextSendWindow()` (U3); U5 is the first runtime caller. Schema gained optional `priority_lookahead_hours` (default 48) in U3 — v1 unchanged, no new version written |
| apify_actor_templates | v3 | 2026-07-13 | site crawler → `playwright:adaptive` |
| compliance_footer | v2 | 2026-07-13 | CAN-SPAM signature block |
| cta_variants | v2 | 2026-07-13 | natural human CTA questions |
| proof_points | v1 | 2026-07-13 | `us-realestate` null; `lt-events` verified |

`linkedin_senders` is agreed but not yet created. `operations_pause` arrives at U9. 28 settings rows across 13 keys, confirmed by `ping.ts` 2026-09-21.

---

## 8. Weekly metrics snapshot (fill from digest, Mondays)

| Week | Sourced | Qualified | Parked | Sent | Reply % | Meetings | Inbox health |
|---|---|---|---|---|---|---|---|
| — | 34 | 17 scored | 19 | 0 | — | 0 | no inboxes yet |
