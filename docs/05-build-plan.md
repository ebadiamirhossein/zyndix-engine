# Zyndix Outbound Engine — Build Plan

**Version:** 1.0 · **Date:** 2026-07-08 · **File:** `05-build-plan.md`
**Method:** same discipline as the zyndix-web build — one focused Cursor prompt per step, tested before moving on, progress logged in `06-build-progress.md`. This file is the contract; new ideas go to the Backlog (§4), not into the current step.

**Prerequisites before step 1 (Amir, outside Cursor):**
- [ ] Supabase project created (`zyndix-engine`), URL + service-role key saved
- [ ] Anthropic API key
- [ ] Apollo API key + confirm plan/export credits
- [ ] Apify account + token
- [ ] NeverBounce (or MillionVerifier) API key
- [ ] Instantly: buy 2 pre-warmed lookalike domains + 4 inboxes; API key; verify SPF/DKIM/DMARC pass (mail-tester)
- [ ] Attio API key
- [ ] Telegram bot created via @BotFather → token; get Amir's + Ingrida's Telegram user IDs
- [ ] GitHub repo `zyndix-engine` (private) + Vercel project linked
- [ ] Calendly webhook signing key (when reaching step 12)

---

## 1. Phase 1 build steps (v1 core loop)

Each step = one Cursor prompt. Definition of done (DoD) must pass before "next".

**Step 1 — Scaffold & foundations**
Next.js App Router + TS + Tailwind, repo structure per 03-architecture §2, Supabase client (`lib/db.ts`, server-only), env template, `CRON_SECRET` check helper, zod installed, `/scripts` folder with a `ping.ts` that reads/writes a test row.
DoD: `pnpm build` passes; `pnpm tsx scripts/ping.ts` round-trips Supabase.

**Step 2 — Migrations (full schema)**
Implement 02-database-schema exactly: all tables, indexes, partial unique on settings, updated_at triggers, RLS on with service-role policy.
DoD: `supabase db push` clean; script inserts + reads one row per table.

**Step 3 — Settings system**
`lib/settings.ts` (load active, 60s cache), seed script writing v1 content from 04-prompts-and-icp (all keys), version-bump write path.
DoD: seed runs; `scripts/show-settings.ts` prints active versions; editing creates v2 and v1 stays.

**Step 4 — State machine**
`lib/state.ts`: allowed-transitions map from 02-schema §5, single `transition(leadId, to, detail)` writing lead + lead_events atomically; invalid transition throws.
DoD: unit-style script proves legal path and rejects an illegal jump.

**Step 5 — Apollo integration + source stage**
`integrations/apollo.ts` (typed search + person fetch), `stages/source.ts`: pull N companies for active segment, dedupe on domain/apollo ids, create companies+leads in `sourced`, suppression check.
DoD: `scripts/test-source.ts` pulls 5 real us-realestate companies into Supabase, re-run creates zero duplicates.

**Step 6 — Apify integration + enrich stage** ✅
`integrations/apify.ts` (run actor, poll, fetch dataset); `apify_actor_templates` settings key (seeded v1); `stages/enrich.ts`: batched site crawl + tech stack + LI posts per lead batch → `enrichment_payloads`, state → `qualifying`. Site crawler covers `/careers`/`/jobs` (no separate jobs actor).
DoD: `scripts/test-enrich.ts --limit 3` enriches real leads; payload rows visible; failures retry then flag.

**Step 7 — Anthropic integration + qualify stage**
`integrations/anthropic.ts` (JSON-mode helper + zod parse + one retry); `stages/qualify.ts`: build context from payloads, run qualifier_prompt, write qualification (+history), route: score/evidence rules → qualified or parked. Records prompt_version + model.
DoD: `scripts/test-qualify.ts <domain>` prints the JSON; a thin-website company correctly parks with null hypothesis.

**Step 8 — Attio sync**
`integrations/attio.ts` + sync per 02-schema §6 (person/company/deal, thin), ids stored back.
DoD: qualified lead appears correctly in Attio; re-sync idempotent.

**Step 9 — Verification stage**
`integrations/neverbounce.ts`; `stages/verify.ts`: valid → drafting path; invalid → parked; catch_all → flagged low-priority.
DoD: known-good and known-bad addresses route correctly.

**Step 10 — Writer + Telegram approval**
`stages/draft.ts` (writer_prompt_email, step hints, compliance footer by geo); `integrations/telegram.ts` + `/api/webhooks/telegram`: approval message with buttons, edit flow, whitelist, `/stats` `/show` `/edit` `/pause` `/lead` commands.
DoD: real lead's draft arrives in Telegram; ✅/✏️/❌ all update touches + state correctly; edit stores both bodies.

**Step 11 — Instantly send + capacity ledger + send windows**
`scheduler/ledger.ts` (atomic slot grant), `scheduler/windows.ts` (tz-aware, jitter), `integrations/instantly.ts`, `stages/send.ts` with double suppression check + zyndix.com domain guard.
DoD: approved touch sends through a warm inbox inside window; ledger increments; quota-exhausted send queues for tomorrow; guard refuses a zyndix.com account in a test.

**Step 12 — Webhooks: Instantly + Calendly**
Raw-store-then-process pattern (webhook_events, idempotent): reply → touch update + state `replied` + kill remaining steps; bounce → park + suppression + account bounce-rate update + auto-pause check; open logged; complaint → auto-pause + alert. Calendly `invitee.created` → match → `meeting_booked` + Attio stage + Telegram 🎉 alert.
DoD: simulated payloads drive every path; replay is idempotent.

**Step 13 — Reply classifier + human routing**
`stages/classify.ts` (reply_classifier_prompt), routes: interested/question/objection → Telegram with suggested_reply; ooo → snooze; unsubscribe → suppress silently.
DoD: 5 sample replies classify and route correctly.

**Step 14 — Orchestrator + crons**
`/api/cron/orchestrate` (10-min loop pulling due work per state, batch limits, 3-strike manual_hold), `/api/cron/daily` (ledger rollover, ramp progression, intake throttle sourcing, Attio reconcile; Monday: digest v0 = stats JSON + Claude narrative → Telegram).
DoD: with cron invoked manually, a lead travels sourced→sent end-to-end untouched except one Telegram ✅.

**Step 15 — Dashboard v0**
Overview funnel/stats, capacity controls, settings editor with version history + diff, leads table + detail timeline, digest archive. Auth allow-list.
DoD: quota change from UI affects next ledger day; prompt edit from UI creates new version used by next qualification.

**🎉 v1 complete gate:** 10 real leads processed end-to-end; ≥1 full week of sends within all safety rules; zero unhandled errors in lead_events.

## 2. Phase 2 steps (after v1 gate)
16. Follow-up cadence full automation (steps 2–4 auto-send post-approval-of-step-1) — partially in step 11/14, hardened here.
17. Signal monitoring: weekly re-scan of active-pipeline leads for new triggers (Apify jobs + LI), hypothesis refresh proposals to Telegram.
18. Digest v1: per-angle reply rates, prompt-version attribution, cost report.
19. Few-shot injection workflow: promote best real emails into writer prompt (settings v-bump) from dashboard.

## 3. Phase 3 steps
20. Heyreach integration + LinkedIn lane (connect-note flow, separate ledger rules).
21. Multi-segment concurrency (activate lt-events; per-segment capacity lanes).
22. Calendly loop polish (no-show detection → re-book sequence — dogfooding checklist item #4).

## 4. Backlog (ideas parked, not scheduled)
- Ads conversion uploads (Phase 4 — on Amir's call; attribution capture already live via ads_attribution table)
- Clay as targeted enrichment plug-in if a segment shows <80% email coverage
- Inbound enrichment: free-audit form submissions run through qualify stage automatically
- Slack mirror of Telegram alerts (if team grows)
- skills.sh utility skills evaluation during Cursor sessions (email-sequence scaffolds)
- Auto-send graduation tooling (edit-rate report per segment → one-click enable)
- Add `us-commercial` as a separate segment (commercial/industrial brokerages) with its own qualifier angle. Lee & Associates produced an excellent hypothesis but was correctly parked as out-of-ICP. Do NOT widen us-realestate — a vaguer ICP means a vaguer message.
- Qualification rate is ~20% (1 of 5). To hit 25 contacts/week, source ~125 leads/week. Monitor and revisit QUALIFY_MIN_SCORE (currently 50; Stephan Group scored 52 — a threshold of 60 would have qualified nobody).
- Revisit crawler: fantasticfrank.co (Astro/Vercel) returned no pages to `website-content-crawler` in cheerio mode. JS-rendered sites may need `crawlerType: playwright`. Test before assuming the site is uncrawlable.

## 5. Working agreement (Cursor discipline)
- One step per prompt; Cursor reads 01–04 docs first (they live in the repo `/docs`).
- No step starts until previous DoD passes and 06-build-progress.md is updated.
- Schema changes only via new migrations; prompts only via settings versions.
- Every step ships its `/scripts/test-*.ts`.
- Real sends during build: only to Amir-owned test addresses until step 14 DoD.
