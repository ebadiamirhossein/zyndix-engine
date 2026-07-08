# Zyndix Outbound Engine — Build Progress

**File:** `06-build-progress.md` · **Started:** 2026-07-08
**How to use:** update after every Cursor session. Status values: `⬜ not started · 🟨 in progress · ✅ done (DoD passed) · ⛔ blocked`. Decisions and issues get logged here so any new chat (or Ingrida) can reconstruct state instantly. This file + docs 01–05 live in the repo under `/docs`.

---

## 1. Prerequisites checklist (outside Cursor)

| Item | Status | Notes |
|---|---|---|
| Supabase project `zyndix-engine` created | ⬜ | URL + service-role key → .env |
| Anthropic API key | ⬜ | |
| Apollo API key + credits confirmed | ⬜ | plan/tier: ___ |
| Apify account + token | ⬜ | |
| NeverBounce / MillionVerifier key | ⬜ | picked: ___ (by price) |
| Instantly: 2 pre-warmed domains + 4 inboxes bought | ⬜ | domains: ___ , ___ |
| Instantly inboxes pass mail-tester (SPF/DKIM/DMARC) | ⬜ | scores: ___ |
| Attio API key | ⬜ | |
| Telegram bot via @BotFather + user IDs (Amir, Ingrida) | ⬜ | bot: @___ |
| GitHub repo `zyndix-engine` (private) + Vercel linked | ⬜ | |
| Calendly webhook signing key | ⬜ | needed at step 12 |

## 2. Phase 1 step tracker

| # | Step | Status | Session date | DoD result / notes |
|---|---|---|---|---|
| 1 | Scaffold & foundations | ⬜ | | |
| 2 | Migrations (full schema) | ⬜ | | |
| 3 | Settings system + seed | ⬜ | | |
| 4 | State machine | ⬜ | | |
| 5 | Apollo + source stage | ⬜ | | |
| 6 | Apify + enrich stage | ⬜ | | |
| 7 | Anthropic + qualify stage | ⬜ | | |
| 8 | Attio sync | ⬜ | | |
| 9 | Verification stage | ⬜ | | |
| 10 | Writer + Telegram approval | ⬜ | | |
| 11 | Instantly send + ledger + windows | ⬜ | | |
| 12 | Webhooks: Instantly + Calendly | ⬜ | | |
| 13 | Reply classifier + routing | ⬜ | | |
| 14 | Orchestrator + crons | ⬜ | | |
| 15 | Dashboard v0 | ⬜ | | |
| — | **v1 gate:** 10 leads end-to-end, 1 clean week | ⬜ | | |

## 3. Phase 2 / 3 tracker

| # | Step | Status | Notes |
|---|---|---|---|
| 16 | Cadence hardening | ⬜ | |
| 17 | Signal monitoring (re-scan) | ⬜ | |
| 18 | Digest v1 (attribution + costs) | ⬜ | |
| 19 | Few-shot promotion workflow | ⬜ | |
| 20 | Heyreach LinkedIn lane | ⬜ | |
| 21 | Multi-segment concurrency (lt-events on) | ⬜ | |
| 22 | Calendly no-show loop | ⬜ | |

## 4. Phase 0 tracker (manual warm outreach — parallel, not optional)

| Item | Status | Notes |
|---|---|---|
| 20 LT target companies listed | ⬜ | |
| Messages 1–5 sent | ⬜ | |
| Messages 6–10 sent | ⬜ | |
| Messages 11–20 sent | ⬜ | |
| Replies / meetings logged | ⬜ | replies: _ · meetings: _ |
| Best 5 examples promoted into writer prompt (settings v2) | ⬜ | per 04-prompts §8 |

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
| | | |

## 6. Issues / blockers log

| Date | Issue | Status | Resolution |
|---|---|---|---|
| | | | |

## 7. Settings version log (mirror of DB, human-readable)

| Key | Active version | Last change | Note |
|---|---|---|---|
| icp_rubric | v1 (seed) | 2026-07-08 | from 04-prompts-and-icp |
| segments | v1 (seed) | 2026-07-08 | us-realestate active |
| qualifier_prompt | v1 (seed) | 2026-07-08 | |
| writer_prompt_email | v1 (seed) | 2026-07-08 | awaiting Phase-0 few-shots → v2 |
| writer_prompt_linkedin | v1 (seed) | 2026-07-08 | Phase 3 |
| reply_classifier_prompt | v1 (seed) | 2026-07-08 | |
| cadence_default | v1 (seed) | 2026-07-08 | 0/3/7/14, stop on reply |
| capacity_defaults | v1 (seed) | 2026-07-08 | 15→30/day ramp |
| send_windows | v1 (seed) | 2026-07-08 | Tue–Thu priority |

## 8. Weekly metrics snapshot (fill from digest, Mondays)

| Week | Sourced | Qualified | Parked | Sent | Reply % | Meetings | Inbox health |
|---|---|---|---|---|---|---|---|
| | | | | | | | |
