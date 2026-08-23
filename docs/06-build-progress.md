# Zyndix Outbound Engine — Build Progress

**File:** `06-build-progress.md` · **Started:** 2026-07-08 · **Last reconciled:** 2026-08-23 (Session 1)
**How to use:** update after every session. Status values: `⬜ not started · 🟨 in progress / built but DoD not verified · ✅ done (DoD passed) · ⛔ blocked`.

**Evidence discipline (added Session 1).** `✅` means the step's DoD script was actually run and passed, and the output is in `07-build-log.md`. `🟨` means the code exists and looks complete but its DoD has not been demonstrated — either the script was withheld on cost grounds, or it failed, or no such script exists. "The file exists" is not `✅`. Where this file and any earlier handoff disagree, **the repo wins.**

---

## 1. Prerequisites checklist (outside the repo)

Filled Session 1 from `.env.local` **key presence only** — no value was read, printed, or recorded.

| Item | Status | Notes |
|---|---|---|
| Supabase project `zyndix-engine` created | ✅ | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` present; migrations verified applied via `show-settings.ts` |
| Anthropic API key | ✅ | Replaced 2026-08-23 after the old key returned `401`. Verified by a live qualifier call. **Vercel env still needs the new value** |
| Apollo API key + credits confirmed | 🟨 | `APOLLO_API_KEY` present; plan/tier and remaining credits not verified this session |
| Apify account + token | 🟨 | `APIFY_TOKEN` present; balance not verified |
| NeverBounce / MillionVerifier key | ✅ | **MillionVerifier chosen.** `MILLIONVERIFIER_API_KEY` present. `NEVERBOUNCE_API_KEY` absent and superseded — docs 01–05 still say "neverbounce" |
| Instantly: 2 pre-warmed domains + 4 inboxes bought | ⬜ | `INSTANTLY_API_KEY` absent. **Blocks step 11.** See `STEP-11-RUNBOOK.md` Day 0 |
| Instantly inboxes pass mail-tester (SPF/DKIM/DMARC) | ⬜ | nothing to test yet; `send_accounts` table has 0 rows |
| Attio API key | ⬜ | `ATTIO_API_KEY` absent — step 8 deliberately deferred, so not a blocker |
| Telegram bot via @BotFather + user IDs | ✅ | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` present |
| Telegram webhook secret | ⬜ | `TELEGRAM_WEBHOOK_SECRET` absent → `/api/webhooks/telegram` 500s on every request. Approval currently runs via `scripts/telegram-poll.ts` long-poll |
| GitHub repo `zyndix-engine` (private) + Vercel linked | 🟨 | git repo live; Vercel link not verifiable from inside the repo |
| Calendly webhook signing key | ⬜ | `CALENDLY_WEBHOOK_SIGNING_KEY` absent — needed at step 12 |
| Dashboard allow-list | ⬜ | `DASHBOARD_ALLOWED_EMAILS` absent — needed at step 15 |

## 2. Phase 1 step tracker

Reconciled against the repo on 2026-08-23. Evidence column says what the status rests on.

| # | Step | Status | Evidence | DoD result / notes |
|---|---|---|---|---|
| 1 | Scaffold & foundations | 🟨 | build run | `pnpm build` passes (Next 16.2.10, TS clean). **`scripts/ping.ts` does not exist** — the second half of the DoD is unrunnable, and `CLAUDE.md` still tells you to run it |
| 2 | Migrations (full schema) | 🟨 | files + live read | `0000_ping`, `0001_init_schema` (321 lines — all 15 tables from `02-database-schema.md` §2–§4, plus `qualification_history`, `set_updated_at()`, partial unique `settings_key_active_uidx`, `webhook_events` provider/external_id unique, RLS on all 16 tables), `0002_transition_lead` RPC, `0003_apollo_unique`, `0004_source_cursors`. Applied to the live DB — `show-settings.ts`, `test-state.ts` and `test-settings.ts` all round-trip. No per-table insert/read DoD script exists, so not `✅` |
| 3 | Settings system + seed | ✅ | `test-settings.ts` | 8/8 PASS. v2 created, active flipped, v1 preserved, cleanup restored v1 |
| 4 | State machine | ✅ | `test-state.ts` | 11/11 PASS. Legal hops, illegal jump throws `IllegalTransitionError` with no state change and no event row, stale-transition guard fires |
| 5 | Apollo + source stage | 🟨 | files only | `integrations/apollo.ts` (389) + `apollo-types.ts`, `stages/source/` (399 + 120 filters + 40 cursor). `test-source.ts` withheld — Apollo quota. `pnpm test:source-filters` passes 9/9 (name-guard unit tests only) |
| 6 | Apify + enrich stage | 🟨 | files only | `integrations/apify.ts` (295), `stages/enrich/core.ts` (540), `apify_actor_templates` live at **v3** (crawler switched to `playwright:adaptive`). `test-enrich.ts` withheld — real Apify actor spend |
| 7 | Anthropic + qualify stage | ✅ | `test-qualify.ts` | `integrations/anthropic.ts` (167), `stages/qualify/core.ts` (661), `qualifier_prompt` live at **v4**. **Anthropic key replaced 2026-08-23**; `test-qualify.ts --limit 1` re-run **3/3 PASS**, 2,520 tokens, **$0.0093**. Lead `200c7e06` correctly **parked with a `disqualify_reason`** (site returned 404 — no evidence, so no hypothesis). That is the evidence-required rule working, not a miss |
| 8 | Attio sync | ⛔ deferred | operator decision 2026-07-13 | Deliberately deferred (read-only human window; no send dependency). `integrations/attio.ts` and `/api/attio/sync` are placeholders. Not an oversight |
| 9 | Verification stage | 🟨 | files only | `integrations/millionverifier.ts` (149), `stages/verify/core.ts` (418). `test-verify.ts` withheld — spends **Apollo reveal credits** + MillionVerifier credits |
| 10 | Writer + Telegram approval | 🟨 | files only | `stages/draft/core.ts` (542) + `guard.ts` (325), `telegram/handler.ts` (643), `integrations/telegram{,-approval,-format}.ts`, `sequences/default.ts`, `/api/webhooks/telegram/route.ts`. `writer_prompt_email` live at **v7**. Was entirely uncommitted until Session 1; now at `0e772ab`. `test-draft.ts` **not run** — it destroys real data (see §6). The Anthropic key is no longer a reason; the destructive reset block still is. Webhook route unreachable without `TELEGRAM_WEBHOOK_SECRET` |
| 11 | Instantly send + ledger + windows | ⬜ | absence confirmed | No `src/lib/scheduler/` (no `ledger.ts`, no `windows.ts`), no `stages/send.ts`, no `integrations/instantly.ts`. **The zyndix.com send guard does not exist yet** — it arrives with `stages/send.ts`. Blocked on `STEP-11-RUNBOOK.md` Day 0 (domains, Instantly, 4 mailboxes, 14-day warmup) |
| 12 | Webhooks: Instantly + Calendly | ⬜ | absence confirmed | `/api/webhooks/instantly` and `/api/webhooks/calendly` are `.gitkeep` placeholders |
| 13 | Reply classifier + routing | ⬜ | absence confirmed | No `stages/classify.ts`. `reply_classifier_prompt` seeded at v1 and its zod schema is tested by `test-validation.ts`, but no stage consumes it |
| 14 | Orchestrator + crons | ⬜ | absence confirmed | `/api/cron/orchestrate` and `/api/cron/daily` are `.gitkeep` placeholders. `lib/auth/cron.ts` (23 lines) exists |
| 15 | Dashboard v0 | ⬜ | absence confirmed | `src/app/dashboard/.gitkeep` only |
| — | **v1 gate:** 10 leads end-to-end, 1 clean week | ⬜ | | 0 leads have reached `sent` |

**Live pipeline as of 2026-08-23 (after the step 7 re-run):** 34 companies · 34 leads — `parked` 19, `qualifying` 10, `pending_approval` 3, `approved` 1, `enriching` 1 · 17 qualification rows · 4 touches · **0 send_accounts**.

## 3. Phase 2 / 3 tracker

| # | Step | Status | Notes |
|---|---|---|---|
| 16 | Cadence hardening | ⬜ | |
| 17 | Signal monitoring (re-scan) | ⬜ | |
| 18 | Digest v1 (attribution + costs) | ⬜ | |
| 19 | Few-shot promotion workflow | ⬜ | |
| 20 | Heyreach LinkedIn lane | ⬜ | `linkedin_senders` settings key not yet created |
| 21 | Multi-segment concurrency (lt-events on) | ⬜ | `segments` v3 has `lt-events` present with `active: false` |
| 22 | Calendly no-show loop | ⬜ | |

## 4. Phase 0 tracker (manual warm outreach — parallel, not optional)

| Item | Status | Notes |
|---|---|---|
| 20 LT target companies listed | ⬜ | |
| Messages 1–5 sent | ⬜ | |
| Messages 6–10 sent | ⬜ | |
| Messages 11–20 sent | ⬜ | |
| Replies / meetings logged | ⬜ | replies: _ · meetings: _ |
| Best 5 examples promoted into writer prompt | ⬜ | per 04-prompts §8; writer is already at v7 from live iteration, so this becomes v8 |

## 5. Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-07-08 | One orchestrator + stage workers, no agent swarm | determinism, debuggability, cost |
| 2026-07-08 | Supabase = brain, Attio = thin human window | Attio 3-object cap irrelevant; full data ownership |
| 2026-07-08 | Cron-pull over event/queue architecture | replayable, zero queue infra at v1 volume |
| 2026-07-08 | Telegram over Slack for approvals | mobile speed, free bot API, 2-person team |
| 2026-07-08 | Buy pre-warmed Instantly domains; still ramp from 15/day | warmup ≠ immunity |
| 2026-07-08 | Skip Clay, Reply.io, Wappalyzer/BuiltWith at v1 | duplication vs own Claude layer; cost; HTML tool-detect covers 70% free |
| 2026-07-08 | NeverBounce-class verification mandatory before send | bounce >3% burns inboxes |
| 2026-07-08 | Signals (triggers[]) in v1 via LI posts + Apify jobs; monitoring subsystem in Phase 2 | value now, scope control |
| 2026-07-08 | Activation: us-realestate → lt-events, one at a time | learning requires isolation |
| 2026-07-08 | Evidence-required rule enforced at DB level (hypothesis not null) | the anti-generic guarantee |
| 2026-07-08 | Cold sends never from zyndix.com/email.zyndix.com — code guard | domain reputation is unrecoverable |
| 2026-07-08 | Ads conversion module: capture now, upload later on Amir's call | standing instruction: don't jump ahead on ads |
| 2026-07-13 | Step 8 (Attio) deferred, proceed to step 9 | read-only human window; nothing downstream depends on it |
| 2026-07-13 | **MillionVerifier chosen over NeverBounce** | implemented as `integrations/millionverifier.ts`; docs 01–05 still say "neverbounce" and are now wrong |
| 2026-07-13 | Apify site crawler switched to `playwright:adaptive` | `apify_actor_templates` v3; cheerio returned zero pages on JS-rendered sites |
| 2026-08-23 | Build moves from Cursor to Claude Code | remaining DoDs are script-based; the run-read-fix loop closes without a human relay |
| 2026-08-23 | LinkedIn senders will be a `settings` key, not code | sender choice is a per-campaign judgement call; hardcoding means a deploy to change who sends |
| 2026-08-23 | Instantly Hypergrowth over Growth | time, not budget, is the binding constraint |
| 2026-08-23 | API keys stay in Vercel env vars; dashboard shows status only | a dashboard auth bug exposing stored service-role keys is unrecoverable |
| 2026-08-23 | **Telegram long-poll (`scripts/telegram-poll.ts`) stands in for the webhook** | `TELEGRAM_WEBHOOK_SECRET` unset; poll unblocks approvals without a public URL |
| 2026-08-23 | **`✅` requires a passing DoD run, not file existence** | the tracker drifted for six weeks because "built" and "verified" were the same symbol |

## 6. Issues / blockers log

| Date | Issue | Status | Resolution |
|---|---|---|---|
| 2026-08-23 | **`ANTHROPIC_API_KEY` returned `401 authentication_error`.** Proven by `test-qualify.ts --limit 1`. Blocked steps 7, 10, 13, 14 — every Claude call in the engine | ✅ resolved 2026-08-23 | Key replaced in `.env.local`. `test-qualify.ts --limit 1` re-run: 3/3 PASS, 2,520 tokens, $0.0093. **Still to do: replace it in the Vercel env too** — the fix so far is local only |
| 2026-08-23 | **`scripts/test-draft.ts` destroys real data.** Lines 91–103 take the `limit * 2` oldest leads in `pending_approval`/`parked`, `DELETE` their `touches` rows, and force-write `leads.state = 'drafting'` directly — bypassing `lib/state.ts`, writing no `lead_events`. Reverses real parking decisions silently | ⛔ open | Do not run until fixed. Rewrite to seed its own throwaway lead and route every state change through `lib/state.ts` |
| 2026-08-23 | Lead `200c7e06` sat at `qualify_failed` attempt **1/3** after the 401 | ✅ resolved 2026-08-23 | Cleared by the successful re-run. Lead is now `parked` with a `disqualify_reason` (site 404) |
| 2026-08-23 | `scripts/ping.ts` does not exist, but `CLAUDE.md` and step 1's DoD both name it | 🟨 open | Either write it (5 lines against `_ping`) or drop it from the docs. Not fixed in Session 1 — reconcile-only scope |
| 2026-08-23 | `TELEGRAM_WEBHOOK_SECRET` unset → `/api/webhooks/telegram` returns 500 on every request | 🟨 open | Set the secret and register the webhook, or keep using `telegram-poll.ts` until step 14 |
| 2026-08-23 | `source_cursors` (migration `0004`) is not documented in `02-database-schema.md` | 🟨 open | Add it to the schema doc |
| 2026-08-23 | Docs 01–05 say "NeverBounce"; the code is MillionVerifier | 🟨 open | Correct the docs, or note the substitution inline |
| 2026-07-13 | **JS-rendered sites returned no pages to the crawler.** `fantasticfrank.co` (Astro/Vercel) returned zero pages to `website-content-crawler` in cheerio mode | 🟨 mitigated, unverified | `apify_actor_templates` bumped to v3 with `crawlerType: playwright:adaptive`. **Not yet re-tested against `fantasticfrank.co`** — verify before assuming any site is uncrawlable |
| 2026-07-13 | **Qualification rate ≈ 20%** (1 of 5). To hit the 25-contacts/week target that implies sourcing ~125 leads/week — well above current throughput | 🟨 open | Monitor. Do **not** widen the ICP to close the gap; a vaguer ICP means a vaguer message |
| 2026-07-13 | **`QUALIFY_MIN_SCORE` threshold is unsettled.** Currently 50. Stephan Group scored 52 — at 60 it would have qualified nobody | 🟨 open | Flagged, not resolved. Needs more scored leads before moving it. Do not change it to raise throughput |

## 7. Settings version log (mirror of DB — verified live 2026-08-23)

| Key | Active version | Last change | Note |
|---|---|---|---|
| icp_rubric | v1 | 2026-07-13 | seed content unchanged; `updated_at` bumped 2026-08-23 by `test-settings.ts` cleanup (active flag only) |
| segments | v3 | 2026-07-13 | expanded `exclude_keywords`, dropped president title; `lt-events` present, `active: false` |
| qualifier_prompt | v4 | 2026-07-13 | contradiction rule: discard contested evidence |
| writer_prompt_email | v7 | 2026-07-13 | human CTA rule; no reply-with-keyword language |
| writer_prompt_linkedin | v1 | 2026-07-13 | seed; Phase 3 |
| reply_classifier_prompt | v1 | 2026-07-13 | seed; no stage consumes it yet |
| cadence_default | v1 | 2026-07-13 | 0/3/7/14, stop on reply |
| capacity_defaults | v1 | 2026-07-13 | 15→30/day ramp; auto-pause at 3% bounce / 1 complaint |
| send_windows | v1 | 2026-07-13 | Tue–Thu priority, 08:30–11:00 local |
| apify_actor_templates | v3 | 2026-07-13 | site crawler → `playwright:adaptive` |
| compliance_footer | v2 | 2026-07-13 | CAN-SPAM signature block |
| cta_variants | v2 | 2026-07-13 | natural human CTA questions |
| proof_points | v1 | 2026-07-13 | `us-realestate` null; `lt-events` verified |

**Correction (Session 1):** the previous version of this table listed every key at v1 dated 2026-07-08. That was wrong — nine keys had moved and four keys (`apify_actor_templates`, `compliance_footer`, `cta_variants`, `proof_points`) were missing from it entirely. `linkedin_senders` is agreed but not yet created.

## 8. Weekly metrics snapshot (fill from digest, Mondays)

| Week | Sourced | Qualified | Parked | Sent | Reply % | Meetings | Inbox health |
|---|---|---|---|---|---|---|---|
| — | 34 | 17 scored | 19 | 0 | — | 0 | no inboxes yet |
