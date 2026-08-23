@AGENTS.md

# Zyndix Outbound Engine

Semi-autonomous cold outbound: sources companies matching the ICP, enriches them, uses Claude to qualify each against an evidence-backed problem hypothesis, drafts a personalised first touch, routes it to a human on Telegram for approval, sends through Instantly, and books free-audit calls. Supabase is the system of record.

Stack: Next.js (App Router, TypeScript strict) on Vercel · Supabase/Postgres · Anthropic API · Vercel Cron · Telegram Bot API.

---

## Read before doing anything

`/docs/01-PRD.md` through `/docs/07-build-log.md`.

Read them in this order, and read the **most recent entry in `07-build-log.md` first** — it tells you where the last session stopped, what broke, and what the next action is. Reading it last wastes the session.

| Doc | What it is |
|---|---|
| `01-PRD.md` | Requirements, scope, success metrics |
| `02-database-schema.md` | Tables, lead state machine, RPCs |
| `03-architecture.md` | Orchestrator, stage workers, integrations, env vars |
| `04-prompts-and-icp.md` | Qualifier, writer, classifier prompts; ICP rubric; segments |
| `05-build-plan.md` | **The contract.** 15 steps, each with a Definition of Done |
| `06-build-progress.md` | Status board — tables, checkboxes, decisions log |
| `07-build-log.md` | Append-only session journal — what actually happened |
| `STEP-11-RUNBOOK.md` | Manual sending-infrastructure setup (domains, DNS, warmup) |

---

## Commands

```bash
pnpm install
pnpm build                              # production type-check and compile
pnpm tsx scripts/ping.ts                # Supabase round-trip
pnpm tsx scripts/test-<stage>.ts        # per-step DoD scripts
```

Migrations are applied **manually in the Supabase SQL editor**. The Supabase CLI was dropped. A migration is not done until a verification query proves the new state.

---

## The contract

`05-build-plan.md` is authoritative. One step per session. A step is finished only when its Definition of Done passes with real output — "this should work" is not a DoD.

New ideas go to the Backlog section of the build plan. Never into the current step.

---

## End of every session — mandatory

Before finishing, do both:

1. Update the relevant tables in `06-build-progress.md`.
2. Append a session entry to the **top** of the Sessions section in `07-build-log.md`, using the template in that file.

A session that changed nothing still gets an entry saying so. Record failures and dead ends explicitly — a dead end that isn't written down is one you'll walk into again. Paste actual command output for verifications; don't summarise it.

---

## Hard rules

These were argued through already. Do not relitigate them; see the decisions log in `06-build-progress.md` §5.

**Sending**
- Cold email NEVER sends from `zyndix.com` or `email.zyndix.com`. There is a guard in `stages/send.ts`. Do not weaken it, do not add an override flag, do not bypass it in tests — a test that the guard *refuses* a zyndix.com account is part of Step 11's DoD.
- Suppression is checked twice: at source, and again immediately before every send.
- During build, real sends go only to Amir-owned test addresses until Step 14's DoD passes.

**Qualification**
- No lead is contacted without a named, evidence-backed `problem_hypothesis`. No evidence → hypothesis is null → the lead parks. This rule is the entire point of the engine; it exists because a generic 1,000-email campaign produced zero clients.
- Absence of evidence is not evidence of absence — a missing signal does not disqualify.
- Contradictory evidence discards the hypothesis rather than averaging it.
- Claude confidence below 0.7 forces `route_to_human`. The engine never guesses its way into a send.
- Do not widen the ICP or change `QUALIFY_MIN_SCORE` to raise throughput. A vaguer ICP means a vaguer message. Flag the tension; don't resolve it in code.

**Data**
- Apollo search and reveal stay split. Search is free and happens early; reveal costs credits and happens only after qualification passes.
- All lead state changes go through `lib/state.ts` — the only place `leads.state` is written. Invalid transitions throw.
- Schema changes only via new SQL migrations. Never edit an applied migration.
- Prompts and the ICP change only via new `settings` versions with a `change_note`. Never hardcode a prompt.
- Zod-validate every integration payload and every Claude output at the boundary. Malformed Claude output → retry once → `manual_hold`. Never guess-send.

**Secrets**
- API keys live in Vercel environment variables. Never store credential values in Supabase, never expose them through the dashboard, never print them in logs or session entries — not even partially. Report presence and absence only.
- The dashboard may show key *status* (present / valid / last verified / credits remaining) and offer a per-service test button. It must never read or write the values.

---

## Cost and safety gate

Before running anything that spends money or leaves the machine — Apollo reveals, Apify actor runs, Anthropic tokens beyond a single test call, email sends, Telegram messages, Attio writes — **stop, say what it will cost, and wait for an answer.** Do not decide this yourself, even mid-task.

Free and safe without asking: `pnpm build`, Supabase reads, local logic and state-machine tests, `scripts/ping.ts`.

---

## Conventions

- Every step ships its own `scripts/test-*.ts`.
- One bad lead never blocks a batch: try/catch per lead, error to `lead_events`, 3 strikes → `manual_hold` + Telegram alert.
- Raw webhooks are stored before processing (`webhook_events`, idempotent on provider external ID) so anything can be replayed.
- Store `timestamptz` in UTC everywhere; compute send windows in app code from the lead's IANA timezone.
- Configuration that a human would want to change weekly belongs in `settings`, not in code. This includes which LinkedIn accounts send (`linkedin_senders`) — sender choice is a per-campaign judgement call, not a deploy.

---

## Scope discipline

If you find something broken that takes under five minutes and blocks the build (a bad import, a missing type export), fix it and note it in the log. Anything larger: report it and stop.

Do not refactor code you were not asked to touch. Do not "improve" a prompt you happen to read. Do not implement a later step because the current one finished early — the ordering exists because each step's DoD depends on the one before it.
