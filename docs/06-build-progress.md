# Zyndix Engine — Build Progress

**File:** `06-build-progress.md` · **Started:** 2026-07-08 · **Last reconciled:** 2026-09-21 (Session 3)
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
| MillionVerifier key | ✅ ready | U2 (credits) | `MILLIONVERIFIER_API_KEY` present. `NEVERBOUNCE_API_KEY` absent and superseded |
| Telegram bot + user IDs | ✅ ready | — | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` present; approve path exercised 2026-09-21 |
| **Two sending domains** | ✅ **bought 2026-09-21** | U5 | `zyndixhq.com` and `getzyndix.com`. 301 → `zyndix.com` live on both. These are U5's allowed-sender list. `STEP-11-RUNBOOK.md` §A.1 |
| DNS authentication (MX, SPF, DKIM, DMARC) | ⬜ **at U2** | U4 | Moved out of clock A: DKIM is generated in Google Workspace Admin, which U2 buys. `STEP-11-RUNBOOK.md` §B.0 |
| **Instantly Hypergrowth + 4 mailboxes** | ⬜ **buy at U2** (≈ day 7) | U4 | 🛒 purchase trigger, moved from U3 on 2026-09-21. ~24 days of warmup lands on FIRST SEND READY at U6. `STEP-11-RUNBOOK.md` §B |
| Mailboxes pass mail-tester ≥9/10 | ⬜ | U4 | Nothing to test yet; `send_accounts` has 0 rows |
| `TELEGRAM_WEBHOOK_SECRET` | ⬜ | U9 | Unset → `/api/webhooks/telegram` 500s on every request. Approvals run via `scripts/telegram-poll.ts` |
| `DASHBOARD_ALLOWED_EMAILS` | ⬜ | U1 | Gates who may sign in, and the role each is provisioned with. Format `email:role`, comma-separated; bare email = `viewer` |
| `SUPABASE_ANON_KEY` | ⬜ | U1 | Added by U1. Anon key, **not** service-role, and deliberately not `NEXT_PUBLIC_` |
| Supabase Auth email provider + redirect URL | ⬜ | U1 | Enable Email provider; allow-list `/api/auth/callback` |
| Migration `0005_app_users_roles.sql` applied | ⬜ | U1 | Written; awaiting manual apply in the SQL editor |
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
| U1 | Auth, roles, dashboard shell | 🟨 **implemented** — DoD partly blocked | Code, migration `0005` and `scripts/test-u1-auth.ts` all written. 29/29 runnable checks pass; 19 more are gated on `0005` being applied. See §6 |
| U2 | Durable job system 🛒 | ⬜ not started | 🛒 **Instantly purchase trigger** moved here from U3 on 2026-09-21 |

### Phase 4 (early) — Campaign execution *(18 sessions, incl. UD)*

| Unit | Name | Status | Evidence |
|---|---|---|---|
| U3 | Scheduler: ledger + send windows | ⬜ not started | `capacity_defaults` / `send_windows` seeded, consumed by nothing |
| U4 | Instantly adapter | ⬜ not started | `integrations/instantly.ts` does not exist |
| U5 | Send stage, preflight, guards | ⬜ not started | **The `zyndix.com` guard does not exist yet** — it arrives here |
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

---

## 6. Issues / blockers log

| Date | Issue | Status | Resolution |
|---|---|---|---|
| 2026-08-23 | **`scripts/test-draft.ts` destroys real data.** Selected the oldest real `pending_approval`/`parked` leads, `DELETE`d their touches and force-wrote `leads.state` directly, bypassing `lib/state.ts` and writing no `lead_events` | ✅ **resolved 2026-09-21** | Rewritten against synthetic fixtures with scoped cleanup, all transitions through `lib/state.ts`, an abort guard if any non-fixture lead is in `drafting`, and a before/after non-fixture row-count assertion. 32/32 pass; counts identical |
| 2026-08-23 | `scripts/ping.ts` does not exist, but `CLAUDE.md` and step 1's DoD both name it | ✅ **resolved 2026-09-21** | Written as a **read-only** round-trip. Migration `0001` ends with `drop table if exists _ping`, so the original write-a-row DoD was unrunnable against the real schema |
| 2026-08-23 | `ANTHROPIC_API_KEY` returned `401` | ✅ resolved 2026-08-23 | Key replaced in `.env.local`. **Still to do: replace it in the Vercel env** — the fix is local only |
| 2026-09-21 | **`source_cursors` (migration `0004`) has no RLS and no `updated_at` trigger**, unlike all 16 tables in `0001`. Not exploitable today — `anon`/`authenticated` are ungranted — but it breaks the pattern | 🟨 **fix written, not applied** | `0005_app_users_roles.sql` enables RLS and adds `trg_updated_at`. Awaiting manual apply in the SQL editor; the verification query is in the migration's trailer |
| 2026-09-21 | `STEP-11-RUNBOOK.md` claimed the `zyndix.com` guard was "already enforced by a code guard in `stages/send.ts`". No such file exists | ✅ resolved 2026-09-21 | Runbook corrected. The guard arrives at **U5** and that unit's DoD verifies it |
| 2026-08-23 | `TELEGRAM_WEBHOOK_SECRET` unset → `/api/webhooks/telegram` 500s | 🟨 open | Scheduled into **U9**. `telegram-poll.ts` covers approvals until then |
| 2026-08-23 | `source_cursors` not documented in `02-database-schema.md` | 🟨 open | Docs 01–05 now carry a drift banner naming it. Full reconciliation is **U23** |
| 2026-07-13 | **JS-rendered sites returned no pages to the crawler.** `fantasticfrank.co` returned zero pages in cheerio mode | 🟨 mitigated, unverified | Templates bumped to v3 with `crawlerType: playwright:adaptive`. **Never re-tested against that site** — do not assume any site is uncrawlable |
| 2026-07-13 | **Qualification rate ≈ 20%** (1 of 5), implying ~125 leads/week sourced to hit 25 contacts/week | 🟨 open | Monitor. Do **not** widen the ICP to close the gap — a vaguer ICP means a vaguer message |
| 2026-07-13 | **`QUALIFY_MIN_SCORE` unsettled.** Currently 50; Stephan Group scored 52, so 60 would have qualified nobody | 🟨 open | Needs more scored leads. Do not change it to raise throughput |
| 2026-09-21 | `test-draft.ts` ✏️ edit and ❌ kill paths undemonstrated | 🟨 open | Each needs its own fixture — an approved lead cannot transition to `parked`. Backlogged in `09` §5 |
| 2026-09-21 | **U1's DoD is partly blocked on operator steps.** `app_users` store checks need `0005` applied; the HTTP checks need `SUPABASE_ANON_KEY`, `DASHBOARD_ALLOWED_EMAILS` and the Supabase email provider | 🟨 open | `scripts/test-u1-auth.ts --base-url http://localhost:3000` completes the run once those are done. 29 of 48 checks pass today; the other 19 skip cleanly |
| 2026-09-21 | **`pnpm lint` fails on `main` — 17 errors, 4 warnings**, all `no-explicit-any` in pre-existing `scripts/*.ts` plus unused-var warnings in `src/lib`. Identical counts before and after U1 | 🟨 open, pre-existing | Not touched by U1 (scope discipline). `pnpm build` and `tsc --noEmit` are clean. Worth a dedicated cleanup session — backlogged in `09` §5 |
| 2026-09-21 | **`0002_transition_lead.sql` is `security definer` with no `set search_path`.** Supabase's linter flags this as `function_search_path_mutable` | 🟨 open | Out of U1's scope; fixing it means a new migration replacing the function. Backlogged in `09` §5 |
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
| capacity_defaults | v1 | 2026-07-13 | 15→30/day ramp; auto-pause at 3% bounce / 1 complaint. Consumed by nothing until U3 |
| send_windows | v1 | 2026-07-13 | Tue–Thu priority, 08:30–11:00 local. Consumed by nothing until U3 |
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
