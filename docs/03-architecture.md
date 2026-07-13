# Zyndix Outbound Engine — Architecture

**Version:** 1.0 · **Date:** 2026-07-08 · **File:** `03-architecture.md`
**Stack:** Next.js (App Router, TypeScript) on Vercel · Supabase (Postgres) · Anthropic API (Claude) · Vercel Cron · Telegram Bot API

Deliberate choice: one boring, deterministic pipeline in one repo. LLM calls are functions inside stages — never free-roaming agents. Everything restartable, everything logged.

---

## 1. System diagram

```
                      ┌────────────────────── VERCEL (zyndix-engine) ──────────────────────┐
                      │                                                                     │
  Vercel Cron ──────► │  /api/cron/orchestrate   (every 10 min)                             │
                      │        │  pulls due work from Supabase (state, next_action_at)     │
                      │        ▼                                                            │
                      │  stage workers (lib/stages/*):                                      │
                      │   source → enrich → qualify → sync → verify → draft → send → learn │
                      │        │            │           │                    │              │
                      │        ▼            ▼           ▼                    ▼              │
                      │   Apollo API    Apify API   Anthropic API      Instantly API        │
                      │                              NeverBounce        (Heyreach P3)       │
                      │                                                                     │
                      │  /api/webhooks/instantly   ◄── replies/bounces/opens/complaints    │
                      │  /api/webhooks/calendly    ◄── invitee.created                      │
                      │  /api/webhooks/telegram    ◄── approvals, commands                  │
                      │                                                                     │
                      │  /dashboard/*  (protected admin UI)                                 │
                      │  /api/attio/sync  (engine→Attio; nightly reconcile back)            │
                      └───────────────┬─────────────────────────────────────────────────────┘
                                      ▼
                                  SUPABASE  (system of record: all tables from 02-database-schema)
                                      ▲
                                   Attio (thin human window)      Telegram (approval & alerts)
```

## 2. Repo structure

```
zyndix-engine/
├── supabase/migrations/            # schema from 02-database-schema.md
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── cron/orchestrate/route.ts     # main loop (10 min)
│   │   │   ├── cron/daily/route.ts           # ledger rollover, Attio reconcile, digest (Mon)
│   │   │   ├── webhooks/instantly/route.ts
│   │   │   ├── webhooks/calendly/route.ts
│   │   │   ├── webhooks/telegram/route.ts
│   │   │   └── attio/sync/route.ts
│   │   └── dashboard/                        # admin UI (auth-gated)
│   │       ├── page.tsx                      # stats overview
│   │       ├── leads/ · settings/ · capacity/ · digests/
│   ├── lib/
│   │   ├── stages/       # source.ts enrich.ts qualify.ts verify.ts draft.ts send.ts classify.ts
│   │   ├── integrations/ # apollo.ts apify.ts anthropic.ts neverbounce.ts instantly.ts
│   │   │                 # attio.ts calendly.ts telegram.ts
│   │   ├── scheduler/    # ledger.ts windows.ts cadence.ts
│   │   ├── settings.ts   # load active settings (cached 60s)
│   │   ├── state.ts      # lead state machine transitions (single choke point)
│   │   └── db.ts         # supabase client (service role, server-only)
│   └── types/            # zod schemas for every integration payload + Claude outputs
└── .env.local            # see §7
```

## 3. Orchestrator design (the heart)

`/api/cron/orchestrate` every 10 minutes:

1. Load active settings (prompts, ICP, capacity, windows).
2. Pull batches of due leads per state (`limit` per stage to stay in Vercel time budget, e.g. 10–20):
   - `sourced` → enrich · `enriching(done)` → qualify · `qualified` → attio-sync + verify · `verified` → draft · `approved` → request ledger slot → queue/send · `sent + next_action_at due` → advance cadence step (draft next touch) · `replied` → classify.
3. Each stage worker: idempotent, try/catch per lead, failure ⇒ `lead_events` error entry + retry counter (3 strikes → `manual_hold` + Telegram alert). One bad lead never blocks the batch.
4. All state changes go through `lib/state.ts` — the only place `leads.state` is written. Invalid transitions throw.

Sourcing itself runs inside the daily cron (not every 10 min): pulls N new companies for the active segment only if the pipeline has capacity (fewer than X leads in pre-send states) — the engine self-throttles intake.

**Why cron-pull, not event-push:** replayable, no queue infrastructure, survives failures by simply running again. At 25–50 leads/week this is the right amount of machinery. If volume 10×es, swap in a queue (Inngest/QStash) behind the same stage interfaces.

## 4. Integrations map

| Service | Used for | Notes |
|---|---|---|
| **Apollo** | org/person search + firmographics | REST; respect export credits; store apollo ids for dedupe |
| **Apify** | site crawl, tech stack, LI posts | run actors via API (batched), poll for finish, store raw payloads; actor templates in `apify_actor_templates` settings key |
| **Anthropic** | qualify / draft / classify / digest narrative | model from settings (default claude-sonnet-4-6); zod-validated JSON outputs; temperature low for qualify/classify, higher for draft |
| **NeverBounce** | email verification | single-check API at verify stage |
| **Instantly** | cold email send + webhooks + inbox health | leads pushed per-campaign OR direct send API; webhooks: reply, bounce, open, complaint |
| **Attio** | human CRM window | thin sync per 02-schema §6; nightly reconcile of deal stages |
| **Calendly** | audit bookings | webhook `invitee.created` → match email → meeting_booked + kill sequences |
| **Telegram** | approvals, alerts, quick commands | see §5 |
| **Heyreach** | LinkedIn lane | Phase 3 only; same touch/ledger model |

All integration modules: typed client, zod-parsed responses, single retry with backoff, errors logged to `lead_events`/`webhook_events` — never silent.

## 5. Telegram bot flows

**Approval flow:** draft ready → message to Amir (and Ingrida if owner): lead name/company/segment, hypothesis + evidence one-liner, the draft, buttons:
`✅ Send` (→ approved) · `✏️ Edit` (bot asks for replacement text; edited body stored, draft_body kept for edit-rate) · `❌ Kill` (→ parked, reason logged) · `💤 Snooze 7d`.

**Alerts:** inbox auto-paused · reply classified interested/question (with suggested response) · 3-strike lead failures · weekly digest link.

**Commands:** `/stats` (today/week numbers) · `/pause <inbox>` `/resume <inbox>` · `/show icp` `/show prompt qualifier` · `/edit ...` (guided: bot asks for new text, writes new settings version) · `/lead <email>` (state + history).

Security: bot only responds to whitelisted Telegram user IDs (env var). Webhook secret path.

## 6. Dashboard scope (v0 in Phase 1)

- **Overview:** pipeline funnel counts, this week vs last, inbox health tiles.
- **Capacity:** per-account quota sliders, ramp stage, pause/resume, send-window editor.
- **Settings:** prompt/ICP editor with version history + diff view, change note required.
- **Leads:** searchable table (state, segment, score), lead detail page = full event timeline, enrichment summary, touches thread.
- **Digests:** weekly digest archive.
Auth: simple email allow-list via NextAuth (or Supabase Auth) — two users, no roles complexity.

## 7. Environment variables

```
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
APOLLO_API_KEY
APIFY_TOKEN
NEVERBOUNCE_API_KEY
INSTANTLY_API_KEY
ATTIO_API_KEY
CALENDLY_WEBHOOK_SIGNING_KEY
TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_IDS / TELEGRAM_WEBHOOK_SECRET
CRON_SECRET                     # Vercel cron auth header check
DASHBOARD_ALLOWED_EMAILS
```
Never in client bundles; all API routes verify `CRON_SECRET`/webhook signatures.

## 8. Failure & observability model

- `webhook_events` stores raw before processing (idempotent via provider external_id) — replay = reset `processed=false`.
- `lead_events` is the audit trail; dashboard lead page renders it as a timeline.
- Retry policy: 3 attempts per stage per lead → `manual_hold` + alert. Cron itself is stateless; a crashed run is healed by the next run.
- Cost guard: daily Claude/Apify call counters in `lead_events` aggregates; digest reports weekly API spend estimate.

## 9. Security & compliance hooks

- Suppression check at source AND immediately before send (double gate).
- GDPR delete: dashboard action wipes lead PII + enrichment payloads, writes suppression entry (email hash retained for suppression only).
- Cold sends: engine refuses any send_account whose domain ∈ {zyndix.com, email.zyndix.com} — hard-coded guard.
- All Claude outputs zod-validated; malformed output → retry once → manual_hold (never guess-send).

## 10. Build sequencing note for Cursor

Implement in this order (matches 05-build-plan): migrations → settings loader → integrations (Apollo, Apify, Anthropic) → stages source/enrich/qualify → Attio sync → verify → draft → Telegram bot → send (Instantly) → webhooks → cadence → dashboard v0. Each step ships with a manual test script under `/scripts` (e.g. `pnpm tsx scripts/test-qualify.ts <domain>`).
