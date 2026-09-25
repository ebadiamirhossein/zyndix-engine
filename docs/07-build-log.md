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

### 2026-09-25 — Session 13 — U6 (2 of 3): reconcile, traversal + 8 stop rules, redraft, legacy webhooks

**Unit:** U6, Instantly webhooks, reply freeze, suppression and reconciliation (`09` §U6), session 2 of 3, on `main`. The operator added two items: redraft the 4 drafts under v8, and delete the 2 legacy Make.com webhooks.
**Status at end:** 🟨 **U6 in progress.**
- **Part 1 is complete and tested locally:** `test:traversal` 62/62 (traversal, 8 stop-rule siblings, reconcile).
- Part 2, the live drill, is session 3.
- 🚩 not reached. Nothing was sent to anyone, and nothing can send (no worker until U9).

**Did**
- **Step 0, provider docs.**
  - Read the official OpenAPI spec for `GET /api/v2/emails`. Confirmed: the 20 req/min limit, `email_type` received/sent/manual, `is_auto_reply` 0/1, `lead` (lead email), `body.text`, `timestamp_email`.
  - One read-only live call (`email_type=received`, `limit=3`, field names only) returned **0 items**. So `emails:read` works, and the fixture `emails-received.json` is shaped from the spec with synthetic values.
- **Reconcile** (`src/lib/reconcile/core.ts`, `jobs.ts`, `src/lib/reconcile.ts`):
  - `runStaleStopCheck`, the `stop_processing_stale` rule:
    - A sender with a send accepted 25h–7d ago and zero webhook events since is paused: `health=paused`, its Instantly campaign paused, an escalated exception, one alert.
    - Poll-sourced rows never count as webhook activity.
    - Idempotent.
  - `runReplyPoll`:
    - Per sender, reads received mail from the oldest awaiting send (floored at 30 days). There is no cursor table.
    - Feeds each unseen reply to `processInstantlyEvent` as a deterministic `reply_received` payload marked `source=reconcile_poll`.
    - Caps: 3 pages per sender, 10 requests per run. A 429 or a cap truncates the run; two truncated runs in a row escalate.
  - `webhooks/instantly.ts`:
    - `pauseSender` is extracted and shared with the bounce auto-pause, whose behaviour is unchanged (58/58). `raiseException` is exported.
    - `handleReply` returns `duplicate_reply` for an email id already recorded on a frozen lead. Auto-replies dedupe on `email_id`.
  - `integrations/rate-limit.ts`: a spacing limiter (≥3.05s between calls) applied inside the adapter's `listEmails`, so it is shared with `send.reconcile`.
  - `stages/send/core.ts`: a paused sender now makes **zero** provider calls. Before, it made 2 account-health reads before refusing.
- **Traversal** (`scripts/test-u6-traversal.ts`):
  - One synthetic lead runs `sourced → sent` through the real enrich, qualify, verify and draft stages, the Telegram approve handler and the send job, with every provider mocked.
  - 8 sibling stop rules, then the reconcile cases.
  - To make this possible, the stages gained an optional `leadIds` scope, and verify takes an injectable Apollo client.
- **Redraft** (operator: "go" after the cost statement):
  - New state edges `pending_approval → drafting` and `approved → drafting` (operator decision).
  - The draft stage now rejects a self-signed body, with one revision retry.
  - `scripts/redraft-drafts.ts` is dry-run by default and has a hard ceiling of $0.10.
  - Result: 4 old touches killed (kept), 4 new v8 drafts in `pending_approval`, and 4 Telegram cards sent to the operator.
- **Legacy webhooks:** both Make.com hooks deleted with operator approval.
- **Small blocking fix:** `test-u6-webhooks.ts`'s "wrong token" was `SECRET.slice(0,-1)+"0"`. It equalled the secret whenever the secret ended in `0`, 1 run in 16; seen once this session. It now flips the last digit.

**Files touched**
- `src/lib/reconcile/core.ts`, `src/lib/reconcile/jobs.ts`, `src/lib/reconcile.ts`, `src/lib/integrations/rate-limit.ts`, `src/lib/integrations/__fixtures__/instantly/emails-received.json`: new
- `src/lib/webhooks/instantly.ts`: `pauseSender`, exported `raiseException` (nullable event id, `notify`), `duplicate_reply`, auto-reply dedupe, two new exception kinds
- `src/lib/integrations/instantly.ts` (limiter option), `instantly-types.ts` (documented Email fields), `instantly.test.ts` (+3 tests)
- `src/lib/stages/send/core.ts`: paused-sender pre-check
- `src/lib/stages/{enrich,qualify,verify,draft}/core.ts`: `leadIds` scope. Verify also gets `apollo` injection, and draft gets the sign-off guard
- `src/types/enums.ts`: redraft edges
- `scripts/test-u6-traversal.ts`, `scripts/redraft-drafts.ts`: new. `scripts/test-u5-send.ts` (paused-sender case, health-call counter), `scripts/test-state.ts` (redraft edges), `scripts/test-u6-webhooks.ts` (flake fix)
- `package.json` (`test:traversal`)
- `docs/06-build-progress.md`, `docs/09-build-plan-v2.md`, `docs/07-build-log.md`

**Verification**

Provider docs and the live read (read-only):
```
$ curl -s https://api.instantly.ai/openapi/api_v2.json → GET /api/v2/emails
"Rate Limit: This endpoint has a rate limit of 20 requests per minute" · scopes emails:read|emails:all|all:read|all:all
Email.is_auto_reply: "0 (zero) - is false, and 1 is true" · lead: "The email address of the lead" · ue_type [1,2,3,4]
$ tsx <scratchpad>/probe-emails.ts   (listEmails email_type=received limit=3, field names/types only)
items: 0 next_starting_after: undefined
```

Traversal + stop rules + reconcile, against Supabase (all providers mocked, fetch guard, synthetic fixtures; UUIDs → `<uuid>`, trimmed):
```
$ pnpm test:traversal
BEFORE  leads=34 touches=4 lead_events=223 jobs=0 companies=34 send_accounts=4 suppression_list=0 webhook_events=4 exceptions=0 outbox=0 enrichment_payloads=106 qualification=17 qualification_history=19 sequences=1 capacity_ledger=0 capacity_reservations=0
PASS: happy: send outcome sent (enroll), exactly one enroll call
PASS: happy: lead state sent, touch sent, ledger accepted = 1 — sent/sent/{"accepted":1}
PASS: happy: every hop recorded by lib/state, in order — enriching → qualifying → qualified → verifying → drafting → pending_approval → approved → queued → sent
PASS: stop 1: lead parked at qualify, never qualified or drafted · no hypothesis stored (only "(disqualified: insufficient_evidence)"), zero draft calls
PASS: stop 2: parked at verify, email_status invalid, never drafted · suppression row written (invalid_email)
PASS: stop 3: send refused with suppressed_email · zero enroll calls, lead never sent
PASS: stop 4: send refused with suppressed_domain · zero enroll calls, lead never sent
PASS: stop 5: webhook processed, the queued send job cancelled before any model call · refused ["stale_approval","reply_freeze","manual_hold"] · zero enroll
PASS: stop 6: lead suppressed + do_not_contact; email job AND linkedin_msg job cancelled · refused suppressed_email · zero enroll
PASS: stop 7: send refused with booking_hold · zero enroll
PASS: stop 8: stale check paused the sender (engine health + Instantly campaign) and escalated · alerted once · refused ["sender_unhealthy"] · the send made ZERO Instantly calls of any kind
PASS: stale: webhook event since the send → ok · poll-sourced row does NOT count → paused · send younger than 25h → no_aged_sends · idempotent
PASS: poll: GET /emails with email_type=received, this sender, window from the oldest awaiting send, asc
PASS: poll: missed reply → lead 1 sent → replied, inbound touch, queued job cancelled — replied 1 cancelled
PASS: poll: no model call (freeze before classification) and no network · went through webhook_events marked source=reconcile_poll
PASS: poll: reply already applied by the webhook → already_seen, no second lead_events row · unmatched ignored, no exception · auto-reply recorded only
PASS: poll→webhook: late webhook → duplicate_reply, no second lead_events row, one inbound touch
PASS: poll: second run → both replies already_seen, auto-reply deduped (one auto_reply event)
PASS: 429: truncated (rate_limited), one open exception, no alert · 429 again: escalated, alerted once · page cap: 3 pages → page_cap · complete run → resolved
PASS: the whole run made one enroll call (the happy path) and no network call
PASS: real leads and real senders untouched (state, email status, DNC, health)
AFTER   (identical to BEFORE, 16 tables)
All 62 checks passed.
```
(Grouped: several PASS lines are joined with `·`; nothing else edited.)

Legacy webhooks (operator-approved deletes):
```
$ pnpm tsx scripts/instantly-webhooks.ts --list
webhooks: 2
  0199e630-78d2-71fb-a504-dbfe1fee0cf5 email_sent status=1 → https://hook.eu1.make.com/… headers=[]
  0199e630-78cf-78cc-bbab-d2e9aba15c2f reply_received status=1 → https://hook.eu1.make.com/… headers=[]
$ … --delete 0199e630-78d2-71fb-a504-dbfe1fee0cf5   → DELETED
$ … --delete 0199e630-78cf-78cc-bbab-d2e9aba15c2f   → DELETED
$ … --list   → webhooks: 0
```

Redraft (dry run, then `--apply` after the operator's "go"):
```
$ pnpm tsx scripts/redraft-drafts.ts
=== redraft-drafts (dry run) · writer_prompt_email v8 · compliance_footer v3 ===
5976b68f-…  Real Estate Brokerage Group       lead=pending_approval touch=8fec19d5-… pending_approval pv=7 signs_itself="— Amir"
041142cc-…  Gottesman Residential Real Estate lead=pending_approval touch=9d902e04-… pending_approval pv=7 signs_itself="— Amir"
0f20b919-…  Steffen Group Auctioneers …        lead=approved         touch=5f8f40ff-… approved         pv=7 signs_itself="— Amir"
b48ad46e-…  Stride Real Estate                lead=pending_approval touch=52c8c08a-… pending_approval pv=7 signs_itself="— Amir"
Anthropic estimate: 4 calls × ≈$0.0066 = ≈$0.026 (one retry each ≈$0.053); hard ceiling $0.10.
$ pnpm tsx scripts/redraft-drafts.ts --apply
KILLED touch 8fec19d5-… (pending_approval) · lead 5976b68f-… pending_approval → drafting      (×4; Steffen approved → drafting)
[draft] generic guard rejected lead 041142cc-… (invented number(s) not in evidence/firmographics: 4)   → one revision retry, then passed
Real Estate Brokerage Group          lead=pending_approval pv=8 words_incl_footer=117 signs_itself=no subject="inbound leads sitting in your inbox"
Gottesman Residential Real Estate    lead=pending_approval pv=8 words_incl_footer=118 signs_itself=no subject="inquiry path on your listings"
Steffen Group Auctioneers and Real E lead=pending_approval pv=8 words_incl_footer=103 signs_itself=no subject="consignment leads going cold?"
Stride Real Estate                   lead=pending_approval pv=8 words_incl_footer=106 signs_itself=no subject="leads slipping between offices"
Anthropic: 5 call(s), 9008 tokens, $0.03548 (stage summary: {"drafted":4,"failed":0,"parked_generic":0})
```

Regression:
```
$ pnpm test:send           → All 69 checks passed.   (67 + paused sender: refused sender_unhealthy · zero provider calls 44 → 44)
$ pnpm test:webhooks       → All 58 checks passed.   (×2 after the flake fix; one earlier run hit the 1-in-16 token collision, cleanup restored all counts)
$ pnpm test:webhook-rules 10/10 · test:sending 68/68 · test:instantly 80/80 (+3) · test:apollo 6/6 · test:source-filters 9/9
$ pnpm test:jobs 63/63 · test:scheduler 80/80 · test-state 14/14 (+3 redraft edges) · test-validation 16/16 · test-settings 8/8
$ pnpm tsx scripts/test-draft.ts --limit 1   (1 Anthropic call, 1,578 tokens, $0.00657; Telegram to the operator only) → 36/36
$ pnpm exec tsc --noEmit → clean · pnpm build → clean
$ pnpm exec eslint <every new/changed file> → 0 errors (2 pre-existing unused-var warnings: qualify/core.ts, verify/core.ts)
```

**Status claims, kept separate:**
- **Tested locally:**
  - reconcile (stale stop, reply poll, truncation), cross-path reply dedupe, the paused-sender zero-call path;
  - the full `sourced → sent` traversal with 8 stop rules;
  - the redraft edges and the draft sign-off guard.
- **Verified with provider:** `GET /api/v2/emails` read (`emails:read`), and webhook list/delete (the legacy pair).
- **Mocked only:** `pauseCampaign`, `leads/add`, `emails/reply`, the block list, and a received email from Instantly. There is no real one yet.
- **Nothing is active in production.** Nothing reconcile-related is on cron (U9).

**Decisions** (all in `06` §5)
- **`stop_processing_stale` fails closed.** Poll rows never count as webhook activity.
- **Missed replies are polled through the webhook processor, with no cursor table.** The window is derived from awaiting leads.
- **A reply is deduped by Instantly email id across both paths.** A half-finished attempt still replays.
- **A paused sender makes zero provider calls at send.**
- **Redraft is an explicit state edge** (operator). Old touches are killed, never deleted.
- **The 8 stop rules are pipeline-wide** (operator choice).

**Problems hit**
- **The `test-u6-webhooks` "wrong token" flake** (above). The 58-check suite had passed earlier in this session with the new `pauseSender`, so this was not a regression. Fixed, and re-run twice clean.
- **The Telegram mock first returned `undefined`.** The draft stage reads `sendApproval(...).failed`, so each draft logged an error while the lead still reached `pending_approval`. The mock now returns `{ sent, failed: [] }`.
- **Qualify stores `"(disqualified: <reason>)"`, not null, when disqualified** (the column is not null). The stop-1 assertion was written against null and is now corrected. This is existing, intended behaviour: a marker, never a hypothesis.
- **One redraft hit the invented-number guard** ("4"). The existing one-time revision retry fixed it: 5 calls instead of 4, $0.035 against the $0.10 ceiling.
- **Webhook `email_id` versus the `GET /emails` `id` is unproven equal.** The workspace has no received email yet. Recorded in `06` §6, to be confirmed in the drill.

**Open, carried forward**
- **Operator:**
  - Review and re-approve the 4 v8 drafts in Telegram, Steffen's included. Approval only binds the touch and sender; nothing sends before U9.
  - Add `INSTANTLY_WEBHOOK_SECRET` to the Vercel env at deploy.
- **U6 session 3, the Part 2 live drill.** Gates: a fresh tunnel webhook (with approval); an operator-owned recipient only; threading headers checked; the first live `leads:create`, `emails:create` and `campaigns:update`; and confirming webhook `email_id` equals the `GET /emails` `id`.
- **Backlog (`09` §5):** `scripts/draft-target-leads.ts` is deprecated (it hard-deletes touches).

**Next action**
- **U6 session 3: the Part 2 live drill** (`09` §U6). Use plan mode: it sends, and it writes to Instantly. Start with the gate list in `06` §6: create the tunnel webhook, then enroll the operator-owned mailbox only, observe the provider message id, `touches.status=sent`, `accepted=1` and `leads.state=sent`, then reply and observe the freeze before any classifier.

---

### 2026-09-25 — Session 12 — U6 (1 of 3): timezone fill, signatures, webhooks, reply freeze, suppression

**Unit:** U6, Instantly webhooks, reply freeze, suppression and reconciliation (`09` §U6), session 1 of 3, on `main`. The operator added two pre-items: the US timezone fill and plain-text signatures.
**Status at end:** 🟨 **U6 in progress.**
- The Part 1 core is **tested locally**: `test:webhooks` 58/58, `test:webhook-rules` 10/10.
- Webhook creation on Growth is **verified with provider**: created, a test delivery came through a tunnel, then deleted.
- Still to do: the reconcile job, the traversal plus stop-rule siblings, and the Part 2 live drill.
- 🚩 not reached. Nothing was sent to anyone, and nothing can send (no worker until U9).

**Did**
- **Operator facts, verified or recorded:**
  - Link tracking off: confirmed in the UI (operator).
  - Mail-tester on the getzyndix mailboxes passed after DMARC (operator).
  - `daily_limit 1` and `enable_slow_ramp false` on all four accounts: **re-read via the API** (below).
- **Pre-item 1, US timezone fill.** The read-only probe showed **HQ state stored nowhere**: `companies.city` is null ×34, there is no state column, and the enrichment payloads have no geo fields. So the baseline dry-run was **0/34 resolved**.
  - The operator chose Apollo Organization Enrichment for the 4 send candidates only: 4 calls, 1 credit each per the docs, approved.
  - `sending/us-timezones.ts` holds the state→IANA table. A split state needs a listed city, and nothing is guessed.
  - `fill-us-timezones.ts` is dry-run by default. The enrichment cache is written outside the repo, and `--apply` does not touch lead state.
  - Result: **4/34 resolved, 30 held (`state_missing`)**. Applied with approval.
- **Pre-item 2, signatures.** The sender is now fixed at Telegram approval (operator decision).
  - The approval snapshot and hash cover `send_account_id` and `signature`.
  - `composeOutboundBody` is shared by the hash and the send.
  - New preflight refusal: `sender_signature_missing`.
  - 4 signatures written with approval.
  - Then the regression found a conflict: the v2 compliance footer already signed "— Amir". The operator decided:
    - the signature goes right before the footer;
    - `compliance_footer` v3 drops "— Amir";
    - `writer_prompt_email` v8 forbids a sign-off, and approval refuses a self-signed body;
    - `send_policy` v2 `assignable_senders` = the amir@ mailboxes only (the writer persona is Amir).
- **U6 core.**
  - `0009_send_prereqs.sql` and `0009b_exceptions.sql`, applied by the operator after a local Postgres 16 pre-flight.
  - `lib/webhooks/instantly.ts` plus the `/api/webhooks/instantly` route:
    - token auth (Instantly has no HMAC), constant-time compare;
    - persist-first with a hash `external_id` (the payload has no event id);
    - a reply freezes before any model call; an auto-reply is recorded only;
    - unsubscribe and bounce suppression, bounce-rate auto-pause;
    - the exceptions queue.
  - Instantly adapter additions: `listWebhooks`, `createWebhook` (secret stripped from every response and error), `testWebhook`, `deleteWebhook`.
  - The verify and source stages now use `checkSuppression`. The backlog item, plus the same bug found in source.
- **Found:** 2 legacy Instantly webhooks from 2025-10-15 posting `email_sent` and `reply_received` to Make.com with no auth. Left untouched per the operator; they must be deleted or confirmed before the drill.

**Files touched**
- `supabase/migrations/0009_send_prereqs.sql`, `0009b_exceptions.sql`: new
- `src/lib/webhooks/instantly.ts`, `instantly-server.ts`, `instantly.test.ts`: new. `src/app/api/webhooks/instantly/route.ts`: new (replaces `.gitkeep`)
- `src/lib/sending/us-timezones.ts`, `sender.ts`: new. `approval.ts`, `preflight.ts`, `sending.test.ts`: signature, sender and sign-off guard
- `src/lib/stages/send/core.ts`: composed outbound body, `lead_timezone_source` on `send_queued`
- `src/lib/telegram/handler.ts`: sender at approval, sign-off refusal, APPROVED footer. `src/lib/integrations/telegram-approval.ts`: card note
- `src/lib/integrations/apollo.ts`, `apollo-types.ts`, `apollo.test.ts`, `__fixtures__/apollo/organization-enrich.json`: `enrichOrganization`
- `src/lib/integrations/instantly.ts`, `instantly-types.ts`, `instantly.test.ts`, `__fixtures__/instantly/{webhook-created,webhooks-list,webhook-test-result}.json`
- `src/lib/validation/external.ts`: Instantly payload envelope. `jsonb.ts`: `send_policy.assignable_senders`
- `src/lib/settings/seed-content.ts`: footer v3, writer COMPLIANCE line, `send_policy` v2
- `src/lib/stages/verify/core.ts`, `src/lib/stages/source/core.ts`: suppression scope
- `src/types/enums.ts` (`sender_signature_missing`), `src/types/database-extensions.ts` (0009 columns, `DatabaseWithWebhooks`)
- `scripts/fill-us-timezones.ts`, `instantly-webhooks.ts`, `test-u6-webhooks.ts`, `update-signature-settings.ts`: new. `seed-send-accounts.ts` (`--signatures`), `test-u5-send.ts`, `test-draft.ts`
- `package.json` (`test:apollo`, `test:webhooks`, `test:webhook-rules`), `.env.local.example` (`INSTANTLY_WEBHOOK_SECRET`), `.claude/launch.json` (dev server, `autoPort`)
- `docs/06-build-progress.md`, `docs/09-build-plan-v2.md`, `docs/07-build-log.md`

**Verification**

Operator facts, read-only (`GET /api/v2/accounts`, limit fields only):
```
ingrida@getzyndix.com  first=Ingrida last=Silobrit    daily_limit=1 enable_slow_ramp=false sending_gap=1 signature=(absent)
amir@getzyndix.com     first=Amir last=Ebadi          daily_limit=1 enable_slow_ramp=false sending_gap=1 signature=(absent)
ingrida@zyndixhq.com   first=Ingrida last=Silobrit    daily_limit=1 enable_slow_ramp=false sending_gap=1 signature=(absent)
amir@zyndixhq.com      first=Amirhossein last=Ebadi   daily_limit=1 enable_slow_ramp=false sending_gap=1 signature=(absent)
```

Timezone fill (baseline, then Apollo with approval, then apply with approval):
```
$ pnpm tsx scripts/fill-us-timezones.ts                         → TOTAL leads=34 · get a timezone=0 · stay held=34 {"state_missing":34}
$ pnpm tsx scripts/fill-us-timezones.ts --enrich steffengrp.com,gottesmanresidential.com,rebgrouponline.com,striderealestate.com
[apollo] enrichOrganization: ok (no credit metadata in response)            ×4
ENRICH steffengrp.com → state=Indiana city=Fort Wayne country=United States
ENRICH gottesmanresidential.com → state=Texas city=Austin country=United States
ENRICH rebgrouponline.com → state=Texas city=Houston country=United States
ENRICH striderealestate.com → state=Texas city=Plano country=United States
approved         Steffen Group Auctioneers and Real  Indiana  Fort Wayne  America/Indiana/Indianapolis (hq_state_city)
pending_approval Gottesman Residential Real Estate   Texas    Austin      America/Chicago (hq_state_city)
pending_approval Real Estate Brokerage Group         Texas    Houston     America/Chicago (hq_state_city)
pending_approval Stride Real Estate                  Texas    Plano       America/Chicago (hq_state_city)
TOTAL leads=34 · get a timezone=4 · stay held=30 {"state_missing":30}
$ … --apply   → WROTE companies ×4 (+ enrichment_payloads ×4), WROTE lead timezone ×4
$ … (re-run)  → get a timezone=0 · stay held=30 · already set=4
```

Signatures and settings (dry-run shown, then applied with approval):
```
$ pnpm tsx scripts/seed-send-accounts.ts --signatures --apply   → WROTE send_accounts.signature_text ×4; re-run → SKIP ×4
$ pnpm tsx scripts/update-signature-settings.ts --apply
WROTE  compliance_footer v3      (was v2 "— Amir\nZyndix, MB · Gerosios Vilties …\nNot useful? Reply STOP …")
WROTE  writer_prompt_email v8    (v7 + "Do NOT sign off and do NOT write your name at the end …")
WROTE  send_policy v2            (+ assignable_senders ["amir@zyndixhq.com","amir@getzyndix.com"])
re-run → SKIP ×3
```

Migrations, local pre-flight (throwaway Postgres 16), then applied by the operator:
```
== 0009_send_prereqs.sql ok
== 0009b_exceptions.sql ok     (0005 fails locally only: no Supabase `auth` schema — expected)
8 new columns present · exceptions relrowsecurity t · status check rejects 'bogus'
```

Webhook DoD against Supabase (mocked Instantly, fetch guard, synthetic fixtures; UUIDs → `<uuid>`):
```
$ pnpm test:webhooks
BEFORE  leads=34 touches=4 lead_events=219 jobs=0 companies=34 send_accounts=4 suppression_list=0 webhook_events=3 exceptions=0
PASS: auth: no token → 401 · wrong token → 401 · secret not configured → 500 · invalid JSON → 400
PASS: auth: ZERO rows written by any rejected delivery — {"events":3,"exceptions":0,"leadEvents":219} → same
PASS: dup: first delivery processed → replied · second → duplicate · same webhook_events row · no second lead_events row · no second inbound touch
PASS: order: reply on a queued lead → queued → sent → replied · the late email_sent never regresses the state
PASS: reply: lead sent → replied · queued send job cancelled · lead-level job cancelled · follow-up touch killed · inbound touch
PASS: reply: ZERO network calls — Anthropic (and everything else) uncalled
PASS: ooo: lead stays sent · queued job intact · follow-up touch intact · no inbound touch · return_date 2026-10-12
PASS: ooo: "Automatic reply:" subject on reply_received treated the same · year-less date → 2026-10-05
PASS: unsub: person-level suppression row · lead suppressed + do_not_contact · email job AND linkedin_msg job cancelled · both touches killed · block list ×1
PASS: stop_failed: exception escalated + operator alerted; lead still suppressed
PASS: unknown: exactly one exceptions row · zero lead mutations (leads, lead_events, touches unchanged) · foreign campaign → foreign_campaign · no event_type → invalid_payload
PASS: bounce: sent → bounced, email invalid · suppression · touch bounced · 1/1 > 3% → paused · campaign paused (mock) + alert
AFTER   leads=34 touches=4 lead_events=219 jobs=0 companies=34 send_accounts=4 suppression_list=0 webhook_events=3 exceptions=0
All 58 checks passed.
```
(Grouped: several PASS lines are joined with `·`; nothing else edited.)

Webhook creation on Growth (operator-approved writes), through a Cloudflare quick tunnel to local `pnpm dev`:
```
$ curl -X POST https://allows-improving-bears-faster.trycloudflare.com/api/webhooks/instantly   → 401 (no token)
$ pnpm tsx scripts/instantly-webhooks.ts --create --url https://allows-improving-bears-faster.trycloudflare.com/api/webhooks/instantly
CREATED webhook 01a0d85c-d21a-7f80-88f0-d4393d205987 event_type=all_events status=1 headers=[x-zyndix-webhook-token]
$ pnpm tsx scripts/instantly-webhooks.ts --test 01a0d85c-…
TEST 01a0d85c-…: success=true status_code=200 response_time_ms=1219
webhook_events: test_event processed=true err=none keys=campaign_id,campaign_name,event_type,is_test,lead_email,test_message,timestamp,webhook_id,workspace · exceptions: none
$ pnpm tsx scripts/instantly-webhooks.ts --delete 01a0d85c-…   → DELETED
$ pnpm tsx scripts/instantly-webhooks.ts --list                → webhooks: 2 (the legacy Make.com pair only)
```

Regression:
```
$ pnpm test:sending        → tests 68 · pass 68 · fail 0   (51 + signature, sender, sign-off, US timezone cases)
$ pnpm test:send           → All 67 checks passed.         (64 + signature at step 1 / follow-up / edited-after-approval)
$ pnpm test:instantly      → 77/77   (71 + 6 webhook contract tests)
$ pnpm test:apollo         → 6/6     (new)
$ pnpm test:webhook-rules  → 10/10   (new)
$ pnpm test:jobs 63/63 · test:scheduler 80/80 · test:source-filters 9/9 · test-state 11/11 · test-validation 16/16 · test-settings 8/8
$ pnpm tsx scripts/test-draft.ts --limit 1   (1 Anthropic call, 1,562 tokens; Telegram to the operator only)
PASS: compliance footer appended · body does not sign itself (Session 12)
PASS: approve → approval_hash binds … · sender fixed at approval with a signature (Session 12)
36/36 passed
$ pnpm exec tsc --noEmit → clean · pnpm build → clean (route ƒ /api/webhooks/instantly)
$ pnpm exec eslint <every new/changed file> → 0 errors (1 pre-existing unused-import warning in verify/core.ts)
$ pnpm lint → ✖ 21 problems (17 errors, 4 warnings) — unchanged pre-existing backlog
```

**Status claims, kept separate:**
- **Tested locally:** the webhook processor (58/58 and 10/10), the signature and sender binding, and the US timezone table.
- **Verified with provider:** Instantly webhook create/test/delete on Growth, and Apollo Organization Enrichment.
- **Mocked only:** the block list, campaign pause, `leads/add`, `emails/reply`, and reconcile reads. These reach *verified* in the U6 drill.
- **Nothing is active in production.**

**Decisions** (all in `06` §5)
- **US timezone comes from the HQ state.** A split state needs a listed city; nothing is guessed.
- **The signature is in the approval hash**, so the sender is fixed at approval.
- **The signature goes right before the footer.** The footer drops "— Amir", and approval refuses a self-signed body.
- **Only amir@ mailboxes are assigned**, through `send_policy.assignable_senders`.
- **Webhooks:** static token header, persist first, hash dedupe, `all_events`.
- **An auto-reply is not a reply.**
- **A reply freezes all channels before any model call.** The outbox settlement stays with reconcile.
- **Unsubscribe and bounce are person-level suppression**, with bounce-rate auto-pause. The verify and source stages use the same scope.

**Problems hit**
- **HQ state was nowhere in the DB.** Four Apollo credits resolved the send candidates. The permanent fix, storing location at sourcing, is backlogged. The operator added the rule that person location wins over HQ.
- **Signature vs footer conflict.** It was found by the regression (`test-draft` asserted "— Amir"), and it would have double-signed mail and signed ingrida@ mail as Amir. It was resolved by operator decision before any real approval.
  - The 4 existing drafts carry the old footer and now refuse approval until they are edited or redrafted.
  - Steffen's approved touch is `stale_approval`, as designed.
- **Naming collision.** I first named the webhook-config schema `instantlyWebhookSchema`, which was already the payload envelope in `validation/external.ts`. Renamed it to `instantlyWebhookConfigSchema`.
- **Port 3000 is taken by another local project (`jobpilot`).** It was left alone, and the dev server ran on an auto-assigned port.
- **The quick tunnel returned an empty 404.** The operator's `~/.cloudflared/config.yml` (a named tunnel from July) was being applied. Fixed by running `cloudflared --config <empty.yml> tunnel --url …`; the operator's config was not modified.
- **`test-u6-webhooks.ts` cleanup order.** The first run deleted touches before the suppression rows that reference them (FK). The cascade still restored every count; the order was fixed and the re-run is clean.
- **Legacy Make.com webhooks** (see above) are open and gate the drill.
- In plan mode, throwaway read-only probe scripts ran from the scratchpad, never inside `scripts/`.

**Open, carried forward**
- **Operator:**
  - Check the 2 Make.com webhooks, then delete or confirm them **before the drill**.
  - Edit or redraft the 4 drafts: remove the "— Amir" line, or redraft to pick up footer v3.
  - Re-approve Steffen.
  - Add `INSTANTLY_WEBHOOK_SECRET` to the Vercel env at deploy.
- **U6 sessions 2–3:**
  - `lib/reconcile/core.ts`: `stop_processing_stale` → pause, and missed-reply polling via `GET /api/v2/emails` at 20 rpm.
  - The sourced→sent traversal plus 8 stop-rule siblings.
  - The Part 2 live drill, with gates:
    - Make.com hooks resolved;
    - a fresh tunnel webhook (with approval);
    - the operator-owned recipient only;
    - threading headers checked;
    - the first live `leads:create`, `emails:create` and `campaigns:update`.
- **Backlog (`09` §5):**
  - Store person and HQ location at sourcing/verify (person wins).
  - A per-sender writer persona.
  - Exclude `/api/webhooks/*` from the proxy.

**Next action**
- **U6 session 2: `src/lib/reconcile/core.ts`** plus the traversal and stop-rule siblings (`09` §U6 Part 1, remaining bullets). Use plan mode, because it pauses sends.
  - Build `stop_processing_stale` first: touches sent over 24h ago with zero webhook events → pause the sender (`health paused`) plus its campaign, and raise an exception.
  - Then missed-reply polling through `listEmails({ emailType: "received" })` into the same `handleReply` path.

---

### 2026-09-25 — Session 11 — operator items verified; U5 send stage, preflight, guards, sender pinning

**Unit:** U5, send stage, preflight and guards (`09` §U5), on `main`. Also recorded: three operator items done since Session 10.
**Status at end:** ✅ **tested locally.** `test:sending` passes 51/51 and `test:send` passes 64/64 against Supabase with a mocked Instantly.
- The provider **writes** used by sending (enroll, reply) are mocked only, and reach *verified* in U6 Part 2.
- Two operator-approved production writes were made: the send config seed, and the 4 draft sender campaigns in Instantly.

**Did**
- **Operator items, verified read-only:**
  - **DMARC on `getzyndix.com`:** ✅ exactly one `_dmarc` TXT (dmarcly, `p=none`), confirmed on public and authoritative resolvers.
  - **Instantly daily limit:** 🟨 the API reads **4** on all four accounts, not the intended 1. Flagged for the operator, not changed.
  - **Tracking decision:** recorded. No custom tracking domain, so the CNAME item is closed as not needed.
- **Threading research** (the operator's condition before building engine-owned steps). The official spec has `POST /api/v2/emails/reply` (`eaccount`, `reply_to_uuid`, `subject`, `body`; scope `emails:create`) and `GET /api/v2/emails` (filters `lead`, `campaign_id`, `eaccount`, `search=thread:…`). Replies share the original's `thread_id`. **Conclusion: threading is possible.**
  - U5 is designed around it: step 1 is enrolled into a single-step campaign; steps ≥ 2 are replies into step 1's thread from the same mailbox.
  - Not documented: the RFC `In-Reply-To`/`References` headers, and whether Growth allows the endpoint. Both are now a **U6 gate**.
- **Operator change to the plan:** `timezone_unknown` is a **hold**, not a deferral. The resolution order ends in a single-zone-country fallback.
- **Migrations** (applied by the operator after a local Postgres 16 pre-flight):
  - `0008_touch_approval_binding.sql`:
    - `touches`: `approval_hash`, `approval_snapshot`, `approved_at`, `approved_by`, and `idempotency_key` (unique)
    - `leads.send_account_id`: the sender binding
    - `send_accounts`: `instantly_campaign_id` (unique), plus a unique index on `lower(identifier)`
  - `0008b_outbox.sql`: the `outbox` table (7-state check, unique `idempotency_key`, RLS), with the state and recovery table in its header.
- **`src/lib/sending/`:**
  - `guard.ts`: the `zyndix.com` block plus a code-constant allow-list, with no override.
  - `approval.ts`: canonical-JSON sha256 over recipient, subject, body, step, channel and prompt version.
  - `timezone.ts` plus `single-timezone-countries.ts`, generated from IANA `zone.tab` (tzdata 2026c).
  - `suppression.ts`: normalized matching, person-level versus company-wide.
  - `preflight.ts`: pure, returns every failing verdict in a fixed order.
- **`src/lib/stages/send/core.ts`**, the send stage:
  - The `send.email` job runs load → sender → preflight → reserve → **second preflight on a fresh load** → bind → `approved→queued` → **outbox `dispatching`** → provider → settle.
  - The `send.reconcile` job resolves an uncertain send by asking the provider, never by resending.
  - `jobs.ts` registers both job types; `stages/send.ts` is the server-only wiring. Nothing is on cron (U9).
- **Instantly adapter:** new `createCampaign`, `replyToEmail` (mutations, never retried) and `listEmails` (read). `getCampaign` now parses the config fields. 3 new fixtures and 8 new contract tests.
- **Telegram approve/edit** now write the approval binding. Both are fenced on `status = pending_approval`, which was previously unchecked, and the approver's Telegram id is recorded.
- **New settings key `send_policy`**: schema, seed content, and `SETTING_KEYS`.
- **Scripts:**
  - `test-u5-send.ts` (`pnpm test:send`)
  - `sending.test.ts` (`pnpm test:sending`)
  - `seed-send-accounts.ts` and `instantly-sender-campaigns.ts`: both dry-run by default, with `--apply` gated on the operator
  - `test-draft.ts`: gains two approval-binding asserts

**Files touched**
- `supabase/migrations/0008_touch_approval_binding.sql`, `0008b_outbox.sql`: new
- `src/lib/sending/{guard,approval,timezone,single-timezone-countries,suppression,preflight}.ts`, `sending.test.ts`: new
- `src/lib/stages/send/{core,jobs}.ts`, `src/lib/stages/send.ts`: new
- `src/lib/integrations/instantly.ts`, `instantly-types.ts`, `instantly.test.ts`, `__fixtures__/instantly/{campaign-created,email-reply-sent,emails-list}.json`
- `src/lib/telegram/handler.ts`: approval binding plus status fence
- `src/lib/validation/jsonb.ts` (`sendPolicySchema`), `src/lib/settings/core.ts`, `seed-content.ts` (`send_policy`)
- `src/types/enums.ts` (`OUTBOX_STATES`, `PREFLIGHT_REFUSALS`, touch status `uncertain`), `src/types/database-extensions.ts` (`DatabaseWithSending`)
- `scripts/test-u5-send.ts`, `seed-send-accounts.ts`, `instantly-sender-campaigns.ts`: new; `scripts/test-draft.ts`: two asserts
- `package.json`: `test:sending`, `test:send`
- `docs/06-build-progress.md`: §1 rows, §2 U5, eight §5 decisions, §6 issues, §7 `send_policy`
- `docs/09-build-plan-v2.md`: U5 as-built, U6 threading gate, two backlog items
- `docs/STEP-11-RUNBOOK.md`: §A.1, §B.0, §B.4, §B.6, §E
- `docs/07-build-log.md`: this entry

**Verification**

Operator items, read-only:
```
$ dig TXT _dmarc.getzyndix.com @1.1.1.1 / @8.8.8.8
status: NOERROR
_dmarc.getzyndix.com. 1799 IN TXT "v=DMARC1; p=none; rua=mailto:69fc6c9acbdee@ag.dmarcly.com; ruf=mailto:69fc6c9acbdee@fo.dmarcly.com; sp=none;"
$ dig +short TXT _dmarc.getzyndix.com @dns1.registrar-servers.com | grep -c DMARC1   → 1
$ dig +noall +answer TXT _dmarc.getzyndix.com @dns2.registrar-servers.com | wc -l    → 1
$ dig +short CNAME _dmarc.getzyndix.com @dns1.registrar-servers.com                  → (none)
$ dig +short CNAME track.getzyndix.com / track.zyndixhq.com                          → (none) — intended, no tracking domain

$ pnpm tsx scripts/live-instantly.ts --whoami --accounts --campaigns     (before any write)
workspace: Zyndix · plan_id: pid_g_v2 · accounts: 4
ingrida@getzyndix.com  status=active  warmup=active  daily_limit=4  warmup_score=100  health=healthy
amir@getzyndix.com     status=active  warmup=active  daily_limit=4  warmup_score=100  health=healthy
ingrida@zyndixhq.com   status=active  warmup=active  daily_limit=4  warmup_score=100  health=healthy
amir@zyndixhq.com      status=active  warmup=active  daily_limit=4  warmup_score=100  health=healthy
campaigns: 0 · secret material in output: none · RESULT: pass
GET /api/v2/accounts (limit fields only): daily_limit 4 ×4, sending_gap 1 ×4,
  enable_slow_ramp true (zyndixhq ×2) / false (getzyndix ×2)
GET /api/v2/workspaces/current: no tracking fields exposed → workspace tracking settings are operator-reported
```
Result:
- DMARC ✅.
- `daily_limit` is **4, not 1** 🟨 (flagged).
- The tracking settings cannot be read at workspace level, so they are enforced and read back per campaign (below).

Migrations, local pre-flight (throwaway Postgres 16), then applied by the operator:
```
== 0008_touch_approval_binding.sql ok
== 0008b_outbox.sql ok          (0005 fails locally only: no Supabase `auth` schema — expected)
 outbox | relrowsecurity t
 7 new columns present: leads.send_account_id, send_accounts.instantly_campaign_id,
   touches.{approval_hash, approval_snapshot, approved_at, approved_by, idempotency_key}
```

Pure suite:
```
$ pnpm test:sending
▶ 09 §U5 DoD — preflight table (exact reason strings)
  ✔ ok · suppressed_email · suppressed_domain · reply_freeze · booking_hold · manual_hold · email_unverified
  ✔ email_invalid · sender_unhealthy · quota_exhausted · outside_window · duplicate_company_active
  ✔ stale_approval · blocked_sender_domain · sender_mismatch                              (15 tests)
▶ preflight extras and policy detail                                                     (10 tests)
  ✔ sender_not_allowed · lead_state_invalid · channel_unsupported · recipient changed → stale_approval …
  ✔ every failing rule is reported, in PREFLIGHT_REFUSALS order
▶ sender pinning
  ✔ bound to amir@zyndixhq, follow-up routed to amir@getzyndix → sender_mismatch
  ✔ same bound sender on the follow-up → ok
  ✔ follow-up with no step-1 email to reply to → thread_anchor_missing
  ✔ follow-up whose subject is not Re: <step-1 subject> → stale_approval
  ✔ threadedSubject does not stack prefixes
▶ timezone resolution (operator rule, Session 11)
  ✔ (a) lead + company timezone null, single-zone country → country_fallback, not refused
  ✔ (a') the country may be an English name
  ✔ (b) multi-zone country (US) → timezone_unknown, never outside_window
  ✔ (b) null country → timezone_unknown, even at a weekend instant
  ✔ strict single-zone rule: DE, ES, PT, CY, CA, AU, BR are not fallbacks
  ✔ lead timezone wins over company, company over country; an invalid zone is skipped
▶ 09 §U5 DoD — domain guard sub-table
  ✔ rejects "zyndix.com" · "mail.zyndix.com" · "ZYNDIX.COM" · "zyndix.com." · "a.b.zyndix.com" · " zyndix.com "
  ✔ accepts "zyndixhq.com" · "getzyndix.com" · "amir@zyndixhq.com" · "INGRIDA@GetZyndix.com."
  ✔ an address at zyndix.com is blocked, and lookalikes are not allowed
  ✔ the allow-list holds exactly the two purchased domains and never zyndix.com
▶ approval binding                                                                        (3 tests)
ℹ tests 51 · pass 51 · fail 0
```

DoD against Supabase (mocked Instantly, synthetic fixtures only; UUIDs replaced with `<uuid>`):
```
$ pnpm test:send
=== test-u5-send (tag=test.u5.1790331050853) ===
BEFORE  leads=34 touches=4 lead_events=219 jobs=0 companies=34 send_accounts=0 capacity_ledger=0 capacity_reservations=0 outbox=0 suppression_list=0

--- DoD: happy path (approved → queued → sent) ---
PASS: happy: outcome sent (enroll)
PASS: happy: adapter called exactly once — 1
PASS: happy: lead approved → sent — sent
PASS: happy: ledger accepted = 1 — {"date":"2026-09-29","quota":30,"used":1,"reserved":0,"accepted":1,"failed":0,"reconciled":0,…}
PASS: happy: reserved back to 0, used = 1
PASS: happy: first touch binds the send_account
PASS: happy: outbox accepted with a provider lead id
PASS: happy: enrolled into the bound account's campaign with the approved subject/body as variables
PASS: happy: send_queued event names the lead's own timezone
PASS: happy: sender_bound event written
PASS: happy: touch sent from the bound account with its idempotency key
PASS: happy: re-running the job → already, zero further adapter calls — already
--- threaded follow-up (emails/reply into step 1's thread) ---
PASS: thread: step-1 email not found → thread_anchor_missing (hold)
--- DoD: sender pinning (follow-up routed to the other domain) ---
PASS: pinning: amir@getzyndix after amir@zyndixhq → refused sender_mismatch — [{"reason":"sender_mismatch","detail":{"bound":"<uuid>","attempted":"<uuid>"}}]
PASS: pinning: no capacity reserved on the other account
PASS: pinning: no provider call
PASS: pinning: binding unchanged
--- threaded follow-up sent ---
PASS: thread: follow-up sent via reply
PASS: thread: reply goes from the BOUND mailbox to step 1's email id
PASS: thread: anchor persisted on the step-1 outbox row
PASS: thread: lead stays sent
PASS: thread: ledger accepted = 2 on the bound account
--- DoD: uncertain outcome (timeout after dispatch) ---
PASS: uncertain: outcome uncertain — reason timeout_after_dispatch
PASS: uncertain: outbox.state = uncertain — uncertain
PASS: uncertain: lead still queued
PASS: uncertain: reservation held as uncertain (capacity not freed)
PASS: uncertain: re-running the job calls the adapter ZERO additional times — 1 calls; already/already
PASS: uncertain: exactly one send.reconcile job enqueued
PASS: reconcile: provider shows the lead → reconciled_sent
PASS: reconcile: lead queued → sent, reservation reconciled(sent)
PASS: reconcile: still zero additional enroll calls
--- reconcile: proven absent → not sent, manual_hold, no resend ---
PASS: reconcile: absent → reconciled_not_sent
PASS: reconcile: lead → manual_hold, operator alerted
PASS: reconcile: reservation reconciled(not_sent), nothing resent
--- skipped already_enrolled → uncertain, never treated as sent ---
PASS: already_enrolled: outbox uncertain, reconcile queued
--- DoD: worker crash, lease expires mid-flight ---
PASS: crash: provider was called once, outbox left dispatching
PASS: crash: the expired lease is re-claimed — 2
PASS: crash: re-claim produces ZERO additional adapter calls — 1
PASS: crash: the dispatching row becomes uncertain → reconcile
PASS: crash: lead stays queued
--- DoD: suppression inserted between approval and send ---
PASS: suppression: refused with suppressed_email (case-insensitive match)
PASS: suppression: capacity was reserved, then reserved returns to 0 — 1 → 0
PASS: suppression: no provider call, no outbox row, lead still approved
PASS: suppression: send_refused event records the final-preflight verdicts
--- timezone_unknown is a HOLD, never a deferral (operator rule) ---
PASS: tz: refused timezone_unknown, not outside_window — [{"reason":"timezone_unknown","detail":{"lead_timezone":null,"company_timezone":null,"country":"US"}}]
PASS: tz: send_refused event written
PASS: tz: nothing reserved (reserved stays 0)
PASS: tz: NO deferred job created — 0 → 0
PASS: tz: operator alerted exactly once
PASS: tz: lead stays approved (held, not moved)
--- country fallback: single-zone HQ country resolves the window ---
PASS: fallback: sent, with time_zone Europe/Vilnius from country_fallback
--- outside_window defers to the next window (timezone known) ---
PASS: window: outside_window → deferred, one send.email job queued
PASS: window: the deferred run is inside Mon 2026-10-05 13:30–16:00 Vilnius (secondary; priority is beyond the 48h lookahead) — 2026-10-05T10:47:00.000Z
PASS: window: no provider call, no reservation, lead still approved

AFTER   leads=34 touches=4 lead_events=219 jobs=0 companies=34 send_accounts=0 capacity_ledger=0 capacity_reservations=0 outbox=0 suppression_list=0
PASS: <table> count unchanged ×10
All 64 checks passed.
```
(Trimmed: repeated JSON details and the ten per-table count lines are collapsed. Nothing else was edited.)

Regression:
```
$ pnpm test:instantly            → tests 71 · pass 71 · fail 0     (63 from U4 + 8 new)
$ pnpm test:jobs                 → All 63 checks passed.
$ pnpm test:scheduler            → All 80 checks passed.
$ pnpm test:source-filters       → 9/9
$ pnpm tsx scripts/test-validation.ts → All 16 checks passed.
$ pnpm tsx scripts/test-state.ts      → All 11 checks passed.
$ pnpm tsx scripts/test-settings.ts   → All 8 checks passed.
$ pnpm tsx scripts/test-draft.ts --limit 1   (1 Anthropic call, 1,514 tokens, $0.0061; Telegram to the operator only)
PASS: approve → touch status approved
PASS: approve → body copied from draft_body
PASS: approve → lead state approved
PASS: approve → approval_hash binds subject/body/recipient (U5)
PASS: approve → approved_by and approved_at recorded (U5) — telegram:<operator id>
PASS: leads / touches / lead_events count unchanged — 34/4/219
34/34 passed
$ pnpm exec tsc --noEmit         → clean
$ pnpm build                     → clean
$ pnpm exec eslint <every new/changed file>   → exit 0
$ pnpm lint                      → ✖ 21 problems (17 errors, 4 warnings) — unchanged pre-existing backlog (09 §5)
```

Operator-approved production writes (approved in chat, this session):
```
$ pnpm tsx scripts/seed-send-accounts.ts --apply
instantly: amir@zyndixhq.com status=1 warmup=1 daily_limit=4        (×4, read-only check first)
WROTE  send_accounts amir@zyndixhq.com
WROTE  send_accounts ingrida@zyndixhq.com
WROTE  send_accounts amir@getzyndix.com
WROTE  send_accounts ingrida@getzyndix.com
WROTE  settings send_policy v1

$ pnpm tsx scripts/instantly-sender-campaigns.ts --apply          ← Instantly WRITE (POST /api/v2/campaigns ×4)
instantly campaigns: 0
CREATED amir@getzyndix.com → 27c28218-da39-4b1c-a2d7-25c002052578 status=draft
CREATED amir@zyndixhq.com → 5392fcac-8d29-432b-84ab-c9a50f626ab9 status=draft
CREATED ingrida@getzyndix.com → 69a90ad5-90d4-4c60-a392-5cfe2a46b8e5 status=draft
CREATED ingrida@zyndixhq.com → 3aace2a8-aa2f-425f-87bd-54770b7a5ecb status=draft
DRIFT  on create: link_tracking=undefined (want false)   (×4 — see Problems hit)

$ pnpm tsx scripts/instantly-sender-campaigns.ts --verify          (read-only, after the check was corrected)
OK  amir@getzyndix.com → 27c28218-… status=draft email_list=["amir@getzyndix.com"] open_tracking=false
    link_tracking=not echoed (sent false) text_only=true first_email_text_only=true stop_on_reply=true daily_limit=15
OK  amir@zyndixhq.com → 5392fcac-…    (same fields)
OK  ingrida@getzyndix.com → 69a90ad5-… (same fields)
OK  ingrida@zyndixhq.com → 3aace2a8-…  (same fields)
RESULT: pass (nothing written)

$ pnpm tsx scripts/live-instantly.ts --campaigns
campaigns: 4 — all four zx-sender-* status=draft · secret material in output: none · RESULT: pass
```
Result:
- 4 `send_accounts` rows, each linked to its campaign id, all with `ramp_started_on` null.
- 4 **draft** campaigns with no leads. **Nothing was sent, and nothing can send.**
- The `campaigns:create` scope is now proven live.

**Status claims, kept separate:**
- U5 is **tested locally**: 51/51 pure, 64/64 against the DB.
- **Verified with provider** covers only: campaign **creation** and read-back.
- Mocked only: `leads/add` enrolment, `emails/reply`, `findLeadInCampaign`, `listEmails`. These reach *verified* in the U6 live drill.
- Nothing is **active in production**. No worker runs `send.email` yet (U9).

**Decisions** (all in `06` §5)
- **No custom tracking domain.** Open and link tracking are off, and the first email is text-only.
- **Engine-owned timing, with follow-ups as threaded `emails/reply`.** Step 1 goes through a single-step campaign.
- **The allow-list is a code constant.** The block is evaluated first and has no override.
- **Thresholds live in `send_policy` v1.** Catch-all is **not** sent to in v1.
- **`timezone_unknown` is a hold.** The country fallback applies only to single-zone countries, and the rule is strict: DE, ES, PT and CY are out.
- **An uncertain send is reconciled, never resent.** Proven absence goes to `manual_hold` and alerts the operator; `already_enrolled` is treated as uncertain.
- **Suppression rows with an email are person-level only.**
- **Preflight runs twice:** before the reservation, and on a fresh load after it.

**Problems hit**
- **Two DoD failures on the first DB run, both in my test's expectations; the stage itself behaved correctly:**
  - **Pinning** returned `sender_mismatch` **plus** `thread_anchor_missing`. The mock had no step-1 email yet, and the anchor lookup was keyed to the *attempted* sender.
    - **Fixed in code:** the anchor is now resolved against step 1's own mailbox, since it belongs to the lead, not to the attempt.
    - **Fixed in the test:** the missing-anchor case now runs first, before any anchor exists.
  - **Deferral** expected Tuesday, but from Saturday 12:00 the U3 rule correctly picks Monday's secondary window, because Tuesday's priority window is 68.5h away, beyond the 48h lookahead. The test expectation was corrected.
- **`link_tracking` is not echoed by Instantly.** It was sent `false`, but create and GET omit the field, and `stop_on_auto_reply:false` is omitted the same way, while the required `open_tracking:false` is echoed. The inference is that false-valued optional flags are dropped. `--verify` now calls drift only on an explicit `true` and prints "not echoed". This is an open item: confirm once in the UI.
- **The Instantly account `daily_limit` reads 4**, while the operator set 1. Not touched (it is a live-settings write).
- **Every current lead would hold as `timezone_unknown`.** All 34 companies are US with null timezones, and the leads have none. This is correct under the rule; the fix is populating `leads.timezone` (backlog, U15).
- **The verify stage's `isSuppressed` treats a person-level row's domain as company-wide.** Out of scope; backlogged for U6.
- **In plan mode, a throwaway read-only script was briefly written to `scripts/` and deleted in the same command** (a raw `GET /api/v2/accounts` for limit fields). Noted for completeness.
- The local Postgres pre-flight first failed on `initdb` locale and on a socket path over 103 bytes. Fixed with `LANG=C --no-locale` and TCP-only listening.

**Open, carried forward**
- **Operator:**
  - Re-run mail-tester on both getzyndix mailboxes; DMARC now exists.
  - Check the Instantly daily limit (4 vs 1) in the UI, and whether `enable_slow_ramp` should match across domains.
  - Confirm `link_tracking` is off on one `zx-sender-*` campaign in the UI.
- **Before any US prospect send:** set `leads.timezone`, or every lead holds `timezone_unknown`.
- **U6 gate:**
  - The live drill replies to its own step 1 via `emails/reply`, then inspects `In-Reply-To`/`References` in the operator mailbox and confirms there is no 402 on Growth.
  - If either fails, **stop before any prospect send** and let the operator choose.
  - Also the first live `leads:create`, `emails:create` and `campaigns:update` (activating the one drill campaign).
- **Start of U6** (from Session 10): prove that webhooks can be created on Growth.

**Next action**
- **U6: webhooks, reply freeze, suppression, reconciliation** (`09` §U6). Use plan mode, because it touches suppression and sending.
  - First, a read-plus-one-write probe of webhook creation on Growth; ask before the write.
  - Then `0009_exceptions.sql` and the `/api/webhooks/instantly` route, persisting each event before processing it.
  - Reuse `sending/suppression.ts` for opt-outs, and `stages/send/core.ts` `holdLead`/outbox for stop and reconcile.

---

### 2026-09-25 — Session 10 — sending infra recorded; U4 Instantly adapter

**Unit:** U4, the Instantly adapter (`09` §U4), on `main`. Also docs: the sending infrastructure as built.
**Status at end:** ✅ **tested locally** (63/63). The **read paths are verified with the provider** (live, read-only, 2026-09-25). The write paths are mocked only; they reach *verified* at U6 Part 2.

**Did**
- **Recorded the sending infrastructure as built.** This covers `06` §1/§5/§6, `STEP-11-RUNBOOK.md` §B.0–B.6 and §E, and the `09` §4 purchases row.
  - **zyndixhq.com:** Google Workspace tenant with `amir@` and `ingrida@`. SPF, DKIM and DMARC verified; mail-tester 9.6 on both.
  - **getzyndix.com:** Microsoft 365 Business Basic tenant (2 licences, admin account unlicensed) with `amir@` and `ingrida@`. DKIM enabled.
    - mail-tester 9.6 on both mailboxes, so the **≥9 gate is met**.
    - Both also showed **"You're not fully authenticated"** (operator correction), so authentication is **open pending a re-test**.
  - **Instantly Growth**, with all 4 mailboxes connected and warmup running.
  - **MillionVerifier:** 495 free credits.
- **Sender pinning added to U5's scope and DoD** (operator requirement). The same local parts exist on both domains, so a lead keeps one `send_account` for its whole sequence. Instantly has no per-lead sender field, so the pinning is structural: one Instantly campaign per `send_account`, a lead→account binding in `0008`, and a new preflight reason `sender_mismatch`.
- **Read the official Instantly API v2 docs before writing code:** the OpenAPI spec `api.instantly.ai/openapi/api_v2.json`, plus `developer.instantly.ai` (auth, rate limit, quickstart, webhook guide). Every endpoint in the adapter comes from them.
- **`src/lib/integrations/instantly.ts`** is the client plus the three-way error taxonomy. It has no DB access and no `server-only`.
  - **Reads:** workspace, accounts (cursor paging with a page cap), a single account, warmup analytics, campaigns, `findLeadInCampaign` (U5's reconcile primitive), and webhook event types.
  - **Mutations:** `enrollLead` (single-lead `POST /api/v2/leads/add`, `skip_if_in_workspace` by default), pause/activate campaign, `deleteLead`, and `addBlockListEntry`.
  - **`accountHealth()`** is pure, and the caller supplies the score threshold.
  - **`createInstantlyReadClient()`** exposes no mutating operation at all.
- **`instantly-types.ts`** holds the Zod schemas and the spec's enum label maps. It validates only the fields the adapter consumes, with no coercion, and passes everything else through.
- **`__fixtures__/instantly/*.json`:** 22 synthetic fixtures shaped from the spec, using `example.invalid` addresses and zero UUIDs.
- **`instantly.test.ts`** (`pnpm test:instantly`) is a `node:test` contract suite with fetch mocked.
- **`scripts/live-instantly.ts`** is a read-only live check with an output-buffer secret self-check.

**Files touched**
- `src/lib/integrations/instantly.ts`, `instantly-types.ts`, `instantly.test.ts`: new
- `src/lib/integrations/__fixtures__/instantly/` (22 files): new
- `scripts/live-instantly.ts`: new
- `package.json`: `test:instantly`
- `docs/06-build-progress.md`:
  - header
  - §1: DNS split per domain, Instantly, mailboxes, mail-tester, key rows, MillionVerifier
  - §2: U4 and U5 rows
  - §5: six decisions
  - §6: five issues
- `docs/09-build-plan-v2.md`: U4 provider record, U5 sender pinning (scope and DoD), §4 purchases row
- `docs/STEP-11-RUNBOOK.md`: as-built notes in §B.0/B.1/B.2/B.3/B.6, and §E checklist
- `docs/07-build-log.md`: this entry

**Verification**

DNS (read-only, 2026-09-25):
```
$ dig +short MX/TXT/_dmarc/…_domainkey for both domains
=== zyndixhq.com
MX:     1 smtp.google.com.
TXT(@): "v=spf1 include:_spf.google.com ~all"  (+ google-site-verification)
DMARC:  "v=DMARC1; p=none; rua=mailto:dmarc@zyndix.com; pct=100; adkim=r; aspf=r"
google._domainkey: "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjircPhdNMkHnbnj95…
selector1/selector2._domainkey: (none — Google domain)
track CNAME: (none)
=== getzyndix.com
MX:     0 getzyndix-com.mail.protection.outlook.com.
TXT(@): "MS=ms97682603"  "v=spf1 include:spf.protection.outlook.com -all"
DMARC:  (none)
google._domainkey: (none — M365 domain)
selector1._domainkey (CNAME): selector1-getzyndix-com._domainkey.zyndix.q-v1.dkim.mail.microsoft.
selector2._domainkey (CNAME): selector2-getzyndix-com._domainkey.zyndix.q-v1.dkim.mail.microsoft.
selector1 TXT (resolved): "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0o59YAbj/vnVlt+P1…
selector2 TXT (resolved): "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt5F6tdkhgPWUgOtsH…
track CNAME: (none)

$ dig TXT _dmarc.getzyndix.com @1.1.1.1 | grep status   → status: NXDOMAIN
$ dig TXT _dmarc.getzyndix.com @8.8.8.8 | grep status   → status: NXDOMAIN
```
Result: both getzyndix DKIM selectors **resolve**. **DMARC is absent on `getzyndix.com`**, which is the likely cause of mail-tester's "not fully authenticated". There is no tracking CNAME on either domain. (DKIM public keys truncated at 80 characters; they are public DNS, not secrets.)

```
$ pnpm exec tsc --noEmit                         → clean
$ pnpm build                                     → clean
$ pnpm exec eslint src/lib/integrations/instantly.ts src/lib/integrations/instantly-types.ts \
    src/lib/integrations/instantly.test.ts scripts/live-instantly.ts   → exit 0
$ pnpm lint                                      → ✖ 21 problems (17 errors, 4 warnings) — unchanged pre-existing backlog (09 §5)

$ pnpm exec tsx --test --test-reporter=spec src/lib/integrations/instantly.test.ts
▶ 09 §U4 DoD
  ✔ 200 enroll parses to the typed created shape
  ✔ 429 → InstantlyRetryableError carrying the parsed retry-after (seconds)
  ✔ 429 → retry-after parsed from an HTTP-date
  ✔ 429 without retry-after → retryAfterMs null (caller's backoff decides)
  ✔ 422 → InstantlyPermanentError kind validation
  ✔ 400 → InstantlyPermanentError kind validation
  ✔ timeout raised after the request body flushed → InstantlyUncertainOutcomeError
  ✔ abort raised after the request body flushed → InstantlyUncertainOutcomeError
  ✔ unexpected field shape fails Zod and throws — no silent coercion
  ✔ missing items array fails Zod
▶ taxonomy completeness
  ✔ the same timeout on a read → retryable, retried once
  ✔ connect-phase ECONNREFUSED on a mutation → retryable, not uncertain
  ✔ connect-phase ENOTFOUND on a mutation → retryable
  ✔ ECONNRESET after dispatch on a mutation → uncertain (network_after_dispatch)
  ✔ 500 on a mutation → uncertain (server_error), not retryable
  ✔ 502 on pauseCampaign → uncertain with the campaign fingerprint
  ✔ 500 on a read → retryable, retried once, then succeeds
  ✔ 500 twice on a read → retryable after exactly two calls
  ✔ a read retry honours retry-after, and skips a wait above 10s
  ✔ a mutation is never retried inside the adapter (429 / 500 / timeout) — fetch called once   (3 tests)
  ✔ 401 → auth / 402 → plan / 403 → scope   (3 tests)
  ✔ 404 → permanent validation
  ✔ 2xx with a non-JSON body on a mutation → uncertain (unreadable_response)
  ✔ 2xx with a body that fails Zod on a mutation → uncertain, never a contract error
  ✔ 2xx whose body stream fails mid-read on a mutation → uncertain
  ✔ 200 enroll with inconsistent counts → uncertain (reconcile, do not resend)
  ✔ missing key → permanent config error, and fetch is never called
  ✔ enroll input without an email → permanent validation, no network
  ✔ every error class extends InstantlyError
▶ behaviour
  ✔ skipped duplicate → { outcome: skipped, reason: already_enrolled }
  ✔ blocklisted → { outcome: skipped, reason: blocklisted }
  ✔ enroll request shape: POST /api/v2/leads/add, Bearer auth, workspace dedupe by default
  ✔ dedupe: campaign turns workspace skipping off but keeps campaign skipping
  ✔ pause and delete send no body and no content-type
  ✔ addBlockListEntry posts bl_value
  ✔ findLeadInCampaign matches case-insensitively and posts campaign + contacts
  ✔ findLeadInCampaign returns null when absent
  ✔ listAllAccounts follows next_starting_after across two pages
  ✔ listAllAccounts stops at the page cap and says so
  ✔ getAccount url-encodes the email
  ✔ getWarmupAnalytics parses the aggregate and rejects an empty list without a call
  ✔ workspace and webhook event types parse
  ✔ parseRetryAfter: seconds, fractional, date, past date, garbage, absent
▶ read-only client
  ✔ exposes every read operation and no mutating operation
  ✔ the full client's operations are exactly read ∪ mutating
▶ accountHealth
  ✔ healthy / paused account / connection error / maintenance / warmup banned / warmup paused /
    setup pending / missing score → unknown, never 0 / unknown status code   (9 tests)
  ✔ missing score stays null, not 0
  ✔ score threshold is caller policy: judged only when given
  ✔ worst reason wins
▶ secrets
  ✔ a key echoed back in an error body is redacted
  ✔ the key appears in no message, String(), JSON or stack of any error thrown in this suite
ℹ tests 63
ℹ pass 63
ℹ fail 0
```
(Trimmed: per-test durations. The three parametrised families are collapsed to one line each. Nothing else was edited.)

Live, read-only, against the real account:
```
$ pnpm tsx scripts/live-instantly.ts --all
=== live-instantly (read-only) ===
INSTANTLY_API_KEY: configured

--- whoami ---
workspace: Zyndix
plan_id: pid_g_v2
accounts: 4

--- accounts ---
ingrida@getzyndix.com  provider=microsoft  status=active  warmup=active  daily_limit=30  warmup_score=100  setup_pending=false  warmup_start=2026-09-24T20:52:52.604Z  health=healthy
amir@getzyndix.com  provider=microsoft  status=active  warmup=active  daily_limit=30  warmup_score=100  setup_pending=false  warmup_start=2026-09-24T20:51:25.193Z  health=healthy
ingrida@zyndixhq.com  provider=google  status=active  warmup=active  daily_limit=30  warmup_score=100  setup_pending=false  warmup_start=2026-09-24T19:32:18.719Z  health=healthy
amir@zyndixhq.com  provider=google  status=active  warmup=active  daily_limit=30  warmup_score=100  setup_pending=false  warmup_start=2026-09-24T19:31:13.984Z  health=healthy

--- campaigns ---
campaigns: 0

--- warmup analytics ---
ingrida@getzyndix.com  sent=3 received=11 inbox=3 spam=— health_score=100 (100%)
amir@getzyndix.com  sent=3 received=27 inbox=3 spam=— health_score=100 (100%)
ingrida@zyndixhq.com  sent=3 received=17 inbox=3 spam=— health_score=100 (100%)
amir@zyndixhq.com  sent=3 received=30 inbox=3 spam=— health_score=100 (100%)

--- webhooks probe (plan tier) ---
webhook event types reachable: 18 types
  email_sent, email_bounced, email_opened, email_link_clicked, reply_received, lead_unsubscribed, campaign_completed, account_error, lead_interested, lead_not_interested, lead_neutral, lead_meeting_booked, lead_meeting_completed, lead_closed, lead_out_of_office, lead_wrong_person, custom_label_any_positive, custom_label_any_negative

secret material in output: none
RESULT: pass
```
Result: **pass**.
- Every live response parsed under the same Zod schemas as the fixtures, so the fixtures match reality.
- The run made about 6 read requests. No Instantly data was created or changed.
- `spam=—` is a null `landed_spam`, not zero.

**Status claims, kept separate:**
- U4 is **tested locally** (63/63).
- **Verified with provider** covers workspace, accounts, campaigns list, warmup analytics and webhook event types.
- Not exercised live: `getCampaign`, `findLeadInCampaign` (needs a campaign), and every mutation. Those stay mocked until U6 Part 2.

**Decisions** (all in `06` §5)
- **Instantly Growth, not Hypergrowth.** This supersedes 2026-08-23. The API and webhook event types work on Growth; webhook *creation* is unproven.
- **Two tenants (Google plus Microsoft),** for provider diversity.
- **A lead keeps one `send_account` for its whole sequence,** enforced structurally in U5.
- **For mutations, any 5xx is uncertain, not retryable.** This refines `09` §U4's "429/5xx → retryable", because a 5xx after a POST may have committed. 429 and connect-phase failures stay retryable.
- **Enrollment is a single-lead `leads/add` with `skip_if_in_workspace`.** Instantly has no idempotency-key header, and only the bulk endpoint reports skips.
- **The adapter never retries a mutation** (the U2 jobs own that). The health score threshold is caller policy, and a missing score is `unknown`, never 0.

**Problems hit**
- **The spec and the guide disagree on webhook event names,** and the live list matches neither exactly: it has `custom_label_any_*`, and no `auto_reply_received` or `lead_no_show`. Recorded for U6, which must use the live list.
- **`POST /api/v2/leads` (single create) does not document its skip response,** hence the bulk endpoint with one lead.
- **`getzyndix.com` has no DMARC record.** This is an operator DNS fix, not code.
- **Accounts show `daily_limit=30`,** while the runbook says 0 until U6. Nothing can send without a campaign, and changing it is a live-settings write, so it was not touched. Raised with the operator.
- None in code. `tsc` passed on the first run.

**Open, carried forward**
- **Operator:** add the DMARC TXT on `getzyndix.com`, then re-run mail-tester on both getzyndix mailboxes. Authentication stays open until it passes.
- **Operator:** confirm the intended Instantly `daily_limit` (currently 30 per account).
- **Operator, before U6:** set up the tracking CNAME (`track.`) on both domains.
- **Start of U6:** prove webhook creation on Growth. That is a write, so ask first. If it is refused, U6 needs a plan change or a polling fallback.
- **U5:** sender pinning (`sender_mismatch`); set `send_accounts.ramp_started_on`; treat `InstantlyUncertainOutcomeError` as the outbox `uncertain` state and reconcile via `findLeadInCampaign`; check `reservation.state` on idempotency replays (from Session 9).
- **U5:** the key's write scopes (`leads:create`, `leads:delete`, `campaigns:update`) are first exercised here. A missing scope surfaces as `kind:'scope'`.

**Next action**
- **U5: send stage, preflight, guards** (`09` §U5). Plan mode, because it touches sending. Start with migration `0008` (the touch approval binding plus the lead→`send_account` binding) and `0008b` outbox. Build `sending/guard.ts`: the `zyndix.com` block and the allowed list `zyndixhq.com`/`getzyndix.com`. Inject the U4 adapter through `deps`, as `draft/core.ts` does.

---

### 2026-09-24 — Session 9 — U3 capacity ledger and send windows

**Unit:** U3 — Scheduler: atomic capacity ledger and send windows (`09` §U3), on `main`
**Status at end:** ✅ **tested locally** — both `09` §U3 DoD items pass against Supabase. No provider is involved, so this is the highest status U3 can reach.

**Did**
- `0007_capacity_counters.sql`:
  - adds `reserved`, `accepted`, `failed` and `reconciled` to `capacity_ledger`, each `not null default 0 check (>= 0)`
  - adds `send_accounts.ramp_started_on date`, nullable
  - new `capacity_reservations` table (state check constraint, partial-unique `idempotency_key`, `trg_updated_at`, RLS)
  - the header documents the recovery semantics brief §10 asks for
- `0007b_reserve_capacity.sql`: `reserve_capacity()` and `settle_capacity()`. Both are `security definer` with a pinned `search_path`; PUBLIC, anon and authenticated execute is revoked, service_role granted.
  - The reservation is one guarded `UPDATE … where used + reserved + n <= quota`, so concurrent callers queue on the row lock.
  - Settling is state-guarded: reaching a state the reservation is already in returns `already`, and an invalid transition raises.
- `src/lib/scheduler/`:
  - `windows.ts` (pure): `nextSendWindow`, `jitteredSendAt`, `rampQuota`, `ledgerDate`. Timezone maths runs on Node `Intl`, with no new dependency.
  - `ledger.ts`: `createCapacityLedger`, with every RPC return Zod-validated.
  - `index.ts`: the `server-only` binding.
  - Replaces the `.gitkeep`.
- `sendWindowsSchema` gained an optional `priority_lookahead_hours`. The seeded v1 is unchanged and no settings row was written.
- `scripts/test-u3-scheduler.ts` plus `pnpm test:scheduler`.
- The operator applied both migrations in the SQL editor.

**Files touched**
- `supabase/migrations/0007_capacity_counters.sql`, `supabase/migrations/0007b_reserve_capacity.sql`: new
- `src/lib/scheduler/{windows,ledger,index}.ts`: new; `src/lib/scheduler/.gitkeep`: removed
- `src/lib/validation/jsonb.ts`: `priority_lookahead_hours` (optional)
- `src/types/enums.ts`: `CAPACITY_RESERVATION_STATES`, `CAPACITY_OUTCOMES`
- `src/types/database-extensions.ts`: `DatabaseWithCapacity`
- `scripts/test-u3-scheduler.ts`: new; `package.json`: `test:scheduler`
- `docs/06-build-progress.md`: header, §1 migration row, §2 U3 row, §5 five decisions, §7 two settings notes
- `docs/07-build-log.md`: this entry

**Verification**

Before applying, the SQL was checked against a throwaway local Postgres 16 cluster in the scratchpad. It confirmed:
- 30 parallel `psql` sessions calling `reserve_capacity` at quota 15 → `15 ok / 15 quota_exhausted`, `reserved = 15`, 3 rounds
- 10 concurrent calls with the same key → 1 reservation
- a second release returns `already`
- grants: `postgres` and `service_role` only; RLS `t` on both tables

That was a pre-flight, not the DoD.

Operator, after applying (reported in chat):
```
capacity_ledger       | true
capacity_reservations | true
reserve_capacity | postgres     | EXECUTE
reserve_capacity | service_role | EXECUTE
settle_capacity  | postgres     | EXECUTE
settle_capacity  | service_role | EXECUTE
```

```
$ pnpm exec tsc --noEmit        → clean
$ pnpm build                    → clean
$ pnpm lint                     → ✖ 21 problems (17 errors, 4 warnings) — identical to main (09 §5 backlog)
$ pnpm exec eslint src/lib/scheduler src/types src/lib/validation/jsonb.ts scripts/test-u3-scheduler.ts → exit 0

$ pnpm test:scheduler

=== test-u3-scheduler (tag=test.u3.…) ===

--- windows (pure, Europe/Vilnius, seeded send_windows v1) ---
PASS: Sun 23:00 → next Tuesday 08:30–11:00 (DoD) — priority 2026-09-29 (tue) 2026-09-29T05:30:00.000Z → 2026-09-29T08:00:00.000Z
PASS: Fri 16:30 → Monday secondary 13:30–16:00 (DoD) — secondary 2026-09-28 (mon) 2026-09-28T10:30:00.000Z → 2026-09-28T13:00:00.000Z
PASS: Sat 10:00 → Monday secondary (weekend excluded, Tue is 70.5h out) — secondary 2026-09-28 (mon) …
PASS: Mon 09:00 → Tuesday priority, not Mon 13:30 (lookahead 48h) — priority 2026-09-29 (tue) …
PASS: Wed 09:00 inside the window → starts now — priority 2026-09-30 (wed) 2026-09-30T06:00:00.000Z → 2026-09-30T08:00:00.000Z
PASS: Wed 11:00 exactly → Thursday (end is exclusive) — priority 2026-10-01 (thu) …
PASS: Thu 12:00 → Friday secondary (next priority is Tue, >48h) — secondary 2026-10-02 (fri) …
PASS: DST autumn: Fri 2026-10-23 16:30 EEST → Mon 2026-10-26 13:30 EET = 11:30Z — secondary 2026-10-26 (mon) 2026-10-26T11:30:00.000Z → 2026-10-26T14:00:00.000Z
PASS: DST autumn: Sun 2026-10-25 23:00 EET (transition day) → Tue 08:30 EET = 06:30Z — priority 2026-10-27 (tue) 2026-10-27T06:30:00.000Z → …
PASS: DST spring: Fri 2027-03-26 16:30 EET → Mon 2027-03-29 13:30 EEST = 10:30Z — secondary 2027-03-29 (mon) 2027-03-29T10:30:00.000Z → …
PASS: America/New_York: Wed 07:00 EDT → same day 08:30 EDT = 12:30Z
PASS: weekend:false wins over a listed 'sat' (Fri 16:30 → Mon, never Sat)
PASS: weekend:true with 'sat' listed → Saturday 08:30
PASS: spring-forward gap: a 03:30 opening on 2027-03-28 (03:00→04:00) moves to 04:30 EEST — 2027-03-28T01:30:00.000Z
--- windows edge cases (pure) ---
PASS: only weekend days with weekend:false → config error, never a weekend window — SendWindowConfigError: no send window within 14 days
PASS: invalid IANA timezone throws InvalidTimeZoneError — InvalidTimeZoneError: invalid IANA timezone: "Mars/Olympus_Mons"
PASS: empty timezone throws InvalidTimeZoneError
PASS: InvalidTimeZoneError is exported as a class
PASS: unknown day key is a config error — SendWindowConfigError: priority_days: unknown day "tuesday"
PASS: priority_lookahead_hours: 0 → plain earliest window (Sun 23:00 → Mon secondary) — secondary 2026-09-28
--- jitter (pure, 1000 draws) ---
PASS: jitter within ±17 minutes over 1000 draws — max |offset| = 17.00 min
PASS: every jittered send lies inside the window — 2026-09-29T05:30:00.000Z → 2026-09-29T08:00:00.000Z
PASS: jitter uses both directions — range -16.98 .. 17.00 min
PASS: rng 0.5 → sendAt = base = start + J — 2026-09-29T05:47:00.000Z
PASS: a 10-minute window shrinks the jitter and stays inside
--- ramp curve (pure, capacity_defaults v1: 15→30, +5 every 4 days) ---
PASS: rampQuota day 0 = 15 / day 3 = 15 / day 4 = 20 / day 8 = 25 / day 12 = 30 / day 100 = 30   (6 checks)
PASS: rampQuota before the start date = null
PASS: rampQuota with no ramp start = null (unknown is null, not 0)
PASS: ledgerDate is the UTC date

BEFORE  leads=34 touches=4 lead_events=219 jobs=0 send_accounts=0 capacity_ledger=0 capacity_reservations=0

--- DoD 1: 30 concurrent reserve_capacity at quota 15 → exactly 15 ok ---
PASS: round 1: exactly 15 ok and 15 quota_exhausted — ok=15 quota_exhausted=15
PASS: round 1: capacity_ledger.reserved = 15 — quota=15 used=0 reserved=15
PASS: round 1: 15 reservation rows — rows=15
  (rounds 2–3 identical: 3 PASS each)

--- DoD 2: releasing a reservation decrements ---
PASS: release → ok, reserved 15 → 14 — status=ok reserved=14
PASS: second release is 'already', reserved stays 14 — status=already reserved=14
PASS: freed capacity can be reserved again — … "quota":15,"used":0,"reserved":15
PASS: …and then the day is full again — quota_exhausted
PASS: released reservation has settled_at

--- settle paths: accept / fail / uncertain / reconcile ---
PASS: accept: reserved −1, used +1, accepted +1 — used=1 reserved=4 accepted=1
PASS: fail: reserved −1, failed +1, used unchanged — used=1 reserved=3 failed=1
PASS: uncertain: counters unchanged — capacity stays held — used=1 reserved=3
PASS: uncertain reservation is not settled — settled_at=null
PASS: reconcile sent: reserved −1, used +1, reconciled +1 — used=2 reserved=2 reconciled=1
PASS: reconcile not_sent: reserved −1, reconciled +1, used unchanged — used=2 reserved=1 reconciled=2
PASS: reconciled row records its outcome — reconciled/sent
--- invalid transitions ---
PASS: accepting an accepted reservation is 'already', no double count
PASS: releasing an accepted reservation raises — … cannot release reservation … in state accepted
PASS: reconciling a reservation that was never uncertain raises — … cannot reconcile_sent … in state reserved
PASS: re-reconciling not_sent as sent raises — … in state reconciled
PASS: unknown outcome raises — settle_capacity: unknown outcome resend
PASS: ledger after all paths: quota 10, used 2, reserved 1, accepted 1, failed 1, reconciled 2

--- idempotency keys ---
PASS: same key twice → same reservation, replayed, one increment — reserved=1
PASS: 10 concurrent calls, one key → one reservation — distinct=1 fresh=1
PASS: …and exactly one increment — reserved=2
PASS: replaying a released key returns it as released (no new capacity taken) — released reserved=1

--- quota monotonicity and argument checks ---
PASS: a lower quota lowers the day — quota=10
PASS: a higher quota does not raise it — quota=10
PASS: quota 0 → quota_exhausted
PASS: n=3 reserves 3; a second n=3 against quota 5 is refused whole — 3/3
PASS: n=0 is rejected — … p_n must be 1..1000, got 0
PASS: negative quota is rejected — … p_quota must be 0..10000, got -1
PASS: unknown send account is rejected (FK) — … violates foreign key constraint "capacity_ledger_send_account_id_fkey"
PASS: CapacityLedgerError is the error class

Cleanup: removed 1 fixture send account(s) (ledger and reservations cascade).
AFTER   leads=34 touches=4 lead_events=219 jobs=0 send_accounts=0 capacity_ledger=0 capacity_reservations=0
PASS: leads / touches / lead_events / jobs / send_accounts / capacity_ledger / capacity_reservations count unchanged   (7 checks)

All 80 checks passed.
```
(What was trimmed: the tag, UUIDs and the full JSON settle payloads; rounds 2–3; the ramp and count-unchanged lines, collapsed to one line each. Nothing else was edited.)

Result: **pass**, U3 DoD:
1. 30 concurrent `reserve_capacity` at quota 15 → exactly 15 `ok`, 15 `quota_exhausted`, `capacity_ledger.reserved = 15`. Repeated over 3 dates.
2. Releasing a reservation decrements, and a second release does not.
3. Windows, table-driven:
   - Sun 23:00 Vilnius → Tue 08:30–11:00
   - Fri 16:30 → Mon secondary
   - weekends excluded
   - jitter within ±17 min over 1000 draws
   - DST dates asserted explicitly in UTC: 2026-10-26 and 2027-03-29, plus the transition day itself

The only fixture was one `send_accounts` row, `test.u3.<ts>@example.invalid`, on synthetic 2099 dates. No real row was read for mutation.

**Decisions**
- Window tier rule is the priority lookahead (operator decision this session). The two DoD cases conflict under a plain earliest-window rule (`06` §5).
- Reservations are rows, so every counter change applies at most once across job re-runs (`06` §5).
- An uncertain send keeps its capacity held until reconciled (`06` §5).
- A day's quota only goes down, and quota is counted per sender per UTC day (`06` §5).
- The ramp anchors on `send_accounts.ramp_started_on`; null means not started. `daily_quota` is not used (`06` §5).
- The RPCs return `jsonb`, not `setof`, and `ledger.ts` Zod-parses the shape.
- `DatabaseWithCapacity` uses `Omit<…, "public">`, not a plain intersection, so the widened `capacity_ledger` and `send_accounts` rows replace the generated ones instead of merging with them.

**Problems hit**
- A spec contradiction in `09` §U3's window DoD, described under Decisions. The operator resolved it before any code was written.
- The first `DatabaseWithCapacity` draft intersected `DatabaseWithJobs` rather than omitting its `public`. That would have merged the old and new table shapes. Fixed before the first `tsc`.

**Open, carried forward**
- 🛒 Instantly Hypergrowth, mailboxes, MillionVerifier credits and `STEP-11-RUNBOOK.md` §B.0 DNS: operator task, still due. Each day of delay comes off U6's warmup.
- **U5 must set `send_accounts.ramp_started_on`** for each mailbox when cold sending starts. Until then `rampQuota()` returns null and nothing can be reserved.
- **Replaying an idempotency key returns the reservation in whatever state it is in.** A released or failed reservation comes back `ok: true, replayed: true` with that state. U5 must check `reservation.state` and must not treat a replay as fresh capacity.
- `jitteredSendAt` returns the earliest jittered instant in a window. Spreading a day's volume across the window is U5's job.
- The `app_users`/`jobs` items and the Vercel env items from Sessions 7–8 are unchanged.

**Next action**
- **U4: Instantly adapter** (`09` §U4). Read the current official Instantly API docs first. The contract suite runs over committed fixtures with `fetch` mocked, and the three-way error taxonomy is the load-bearing part. The live `--whoami` check needs the operator's Instantly key, which comes with the 🛒 purchase.

---

### 2026-09-24 — Session 8 (addendum) — work directly on `main`

**Step:** docs
**Status at end:** ✅ done. No code changed.

**Did**
- Operator decision: from now on, work directly on `main`. No feature branches and no PRs.
- Recorded it in `06` §5 and in `CLAUDE.md` §Session discipline. Sessions now end with a commit to `main` and the operator running `git push origin main`.
- U2 had already reached `main` through PR #2 (`6213fa7`), so nothing needed merging. Deleted the local `feat/u2-jobs` branch. The remote branches `feat/u1-auth`, `feat/u2-jobs` and the two `docs/*` branches still exist; deleting them is the operator's call.

**Files touched**
- `CLAUDE.md`: §Session discipline
- `docs/06-build-progress.md`: §5, one row
- `docs/07-build-log.md`: this entry

**Verification**
```
$ git status -sb
## main...origin/main [ahead 1]
```
Result: pass

**Decisions**
- Work on `main` directly: single operator, no reviewer. The DoD, the log and the operator-run push are the safety net (`06` §5).

**Next action**
- Unchanged: **U3**, see Session 8.

---

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
