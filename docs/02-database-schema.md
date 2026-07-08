# Zyndix Outbound Engine — Database Schema (Supabase / Postgres)

**Version:** 1.0 · **Date:** 2026-07-08 · **File:** `02-database-schema.md`
**Principle:** Supabase is the system of record (the brain). Attio holds a clean synced subset (the human window). Every stage of the pipeline reads/writes here; nothing important lives only in a third-party tool.

---

## 1. Entity overview

```
companies ──< leads (people) ──< touches
    │             │  │
    │             │  └──< lead_events (everything that ever happened)
    │             └──── qualification (1:1, latest) + qualification_history
    │
enrichment_payloads (raw Apify/Apollo data, per company/lead)
sequences ──< sequence_steps            (cadence templates)
send_accounts ──< capacity_ledger      (per-day quotas & health)
settings (versioned prompts/ICP/knobs)
suppression_list                        (opt-outs, bounces, do-not-contact)
webhook_events                          (raw inbound webhooks, idempotency)
weekly_digests                          (learning loop snapshots)
```

All tables: `id uuid primary key default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at timestamptz` (trigger-maintained). RLS enabled; service-role key used by the engine; anon access = none.

---

## 2. Core tables

### 2.1 `companies`
| column | type | notes |
|---|---|---|
| name | text not null | |
| domain | text unique | primary dedupe key |
| segment | text | e.g. `us-realestate` (from qualification) |
| country | text | ISO-2 |
| city | text | |
| timezone | text | IANA, for send windows |
| employee_range | text | from Apollo |
| industry | text | from Apollo |
| linkedin_url | text | |
| apollo_org_id | text | |
| attio_company_id | text | set after sync |
| status | text | `new / enriching / qualified / parked / disqualified / active_outreach / replied / meeting / client / lost` |
| park_reason | text | e.g. `no_evidence`, `bad_fit` |

### 2.2 `leads` (people)
| column | type | notes |
|---|---|---|
| company_id | uuid fk → companies | |
| first_name / last_name | text | |
| title | text | |
| email | text | |
| email_status | text | `unverified / valid / catch_all / invalid` |
| email_verified_at | timestamptz | |
| linkedin_url | text | |
| apollo_person_id | text | |
| attio_person_id | text | |
| timezone | text | falls back to company |
| state | text not null | pipeline state machine — see §5 |
| state_changed_at | timestamptz | |
| current_sequence_id | uuid fk → sequences | null when none |
| current_step | int | position in sequence |
| next_action_at | timestamptz | when scheduler should act |
| owner | text | `amir / ingrida / engine` |
| do_not_contact | bool default false | mirror of suppression hit |

Index: `(state, next_action_at)` — the scheduler's main query.

### 2.3 `qualification` (latest, 1:1 with lead) & `qualification_history`
| column | type | notes |
|---|---|---|
| lead_id | uuid fk unique | history table: same minus unique |
| fit_score | int | 0–100 |
| segment | text | |
| problem_hypothesis | text not null | THE field. No hypothesis → row not written → lead parked |
| evidence | jsonb | array of {source, quote/observation} |
| triggers | jsonb | array: `hiring_admin`, `growth_post`, `new_exec`, ... |
| visible_tools | jsonb | detected from HTML: hubspot, calendly, typeform... |
| recommended_angle | text | `speed-to-lead`, `follow-up`, `no-show`, ... |
| disqualify_reason | text | null if qualified |
| prompt_version | int | fk-ish to settings version used — learning loop |
| model | text | e.g. `claude-sonnet-4-6` |

### 2.4 `enrichment_payloads`
| column | type | notes |
|---|---|---|
| company_id / lead_id | uuid fk (either) | |
| source | text | `apollo_org / apollo_person / apify_site / apify_li_posts / apify_jobs` |
| payload | jsonb | raw response |
| fetched_at | timestamptz | |
Retention: raw payloads prunable after 180 days (keep qualification).

---

## 3. Outreach tables

### 3.1 `sequences` & `sequence_steps`
`sequences`: | name | segment | channel (`email/linkedin/mixed`) | active bool | version |
`sequence_steps`: | sequence_id fk | step_no | wait_days (3,7,14…) | channel | template_hint (text for Writer: angle/asset for this touch, e.g. `attach_pdf`) | requires_approval bool |

v1 default sequence: step1 (approval), step2 +3d, step3 +7d `attach_pdf`, step4 +14d, stop.

### 3.2 `touches` (every message sent or drafted)
| column | type | notes |
|---|---|---|
| lead_id | uuid fk | |
| sequence_id / step_no | | |
| channel | text | `email / linkedin_connect / linkedin_msg` |
| direction | text | `outbound / inbound` |
| status | text | `drafted / pending_approval / approved / edited / killed / queued / sent / delivered / bounced / opened / replied / failed` |
| subject | text | email only |
| body | text | final sent text |
| draft_body | text | original Claude draft (diff vs body = edit-rate metric) |
| send_account_id | uuid fk → send_accounts | |
| provider_message_id | text | Instantly/Heyreach id |
| scheduled_for | timestamptz | after ledger slot granted |
| sent_at / opened_at / replied_at | timestamptz | |
| reply_classification | text | `interested / question / objection / not_now / negative / ooo / wrong_person` |
| reply_body | text | inbound content |
| prompt_version | int | Writer version used |

### 3.3 `send_accounts`
| column | type | notes |
|---|---|---|
| kind | text | `email_inbox / linkedin_account` |
| identifier | text | e.g. `amir@zyndixhq.com` |
| domain | text | lookalike domain |
| provider | text | `instantly / heyreach` |
| daily_quota | int | current cap (dashboard knob) |
| ramp_stage | text | `warmup / ramp1 / ramp2 / full` |
| health | text | `ok / degraded / paused` |
| paused_reason | text | `bounce_rate / spam_complaint / manual` |
| bounce_rate_7d | numeric | maintained by webhook processor |

### 3.4 `capacity_ledger`
| column | type | notes |
|---|---|---|
| send_account_id | uuid fk | |
| date | date | |
| quota | int | snapshot of that day's cap |
| used | int | incremented atomically on send |
Unique `(send_account_id, date)`. Send stage requests a slot: `used < quota` AND account `health = ok` AND inside send window → grant + increment, else queue.

### 3.5 `suppression_list`
| column | type | notes |
|---|---|---|
| email / domain / linkedin_url | text | any may be set |
| reason | text | `opt_out / hard_bounce / complaint / manual / gdpr_request` |
| source_touch_id | uuid | |
Checked at SOURCE stage and again before every send. Never deleted.

---

## 4. System tables

### 4.1 `settings` (versioned, live-editable)
| column | type | notes |
|---|---|---|
| key | text | `icp_rubric / qualifier_prompt / writer_prompt_email / writer_prompt_linkedin / reply_classifier_prompt / cadence_default / capacity_defaults / send_windows / segments` |
| version | int | auto-increment per key |
| value | jsonb or text | the content |
| active | bool | exactly one active per key (partial unique index) |
| changed_by | text | `amir / ingrida` |
| change_note | text | why |
Engine always loads `active = true` at runtime. History = every prior row.

### 4.2 `webhook_events`
| provider | text | `instantly / calendly / heyreach / telegram` |
| external_id | text | idempotency key (unique with provider) |
| event_type | text | |
| payload | jsonb | |
| processed | bool | |
| processed_at | timestamptz | |
Raw first, process second — replayable, debuggable.

### 4.3 `lead_events` (append-only audit trail)
| lead_id | uuid fk | |
| event | text | `sourced / enriched / qualified / parked / synced_attio / verified / drafted / approved / sent / opened / replied / classified / meeting_booked / stopped / suppressed` |
| detail | jsonb | |
Everything the digest and debugging need.

### 4.4 `weekly_digests`
| week_start | date | |
| stats | jsonb | per segment: sourced/qualified/sent/opens/replies/meetings; per angle: reply rate; inbox health; prompt versions active |
| narrative | text | Claude-written summary |

### 4.5 `ads_attribution` (module designed now, used later)
| lead_id | uuid fk | |
| gclid / fbclid / li_fat_id | text | captured on free-audit form |
| utm | jsonb | |
| conversion_uploads | jsonb | log of uploads to ad platforms (Phase 4) |

---

## 5. Lead state machine (`leads.state`)

```
sourced → enriching → qualifying ─┬→ parked (no evidence / low fit)
                                  └→ qualified → verifying ─┬→ parked (invalid email)
                                                            └→ drafting → pending_approval
→ approved → queued → sent → (waiting) ─┬→ replied → classifying → human_review / next_action
                                        ├→ bounced → parked + suppression check
                                        └→ no_reply → next step (until sequence end) → sequence_done
replied+interested → meeting_booked → handed_off (Attio deal takes over)
any state → suppressed (terminal) · any state → manual_hold
```

Transitions written to `lead_events`; scheduler drives everything off `(state, next_action_at)`.

---

## 6. Attio sync contract (thin by design)

Synced: person (name, title, email, LinkedIn), company (name, domain, segment), deal (stage mirror of engine state: Lead / Outreach / Replied / Audit booked / Won / Lost), one-line `problem_hypothesis`, `next_action_at`, link back to dashboard lead page.
Not synced: raw payloads, drafts, ledger, settings — Attio stays clean and fast. Sync = one-way engine→Attio in v1; manual Attio edits to deal stage are read back nightly (lightweight reconcile) so human moves aren't lost.

---

## 7. Notes for implementation (Cursor)

- Migrations via Supabase CLI in `/supabase/migrations`; this document is the source of truth for v1 schema — implement exactly, extend only via new migrations.
- Atomic ledger increment: `update capacity_ledger set used = used + 1 where id = ... and used < quota returning *` — no slot if zero rows.
- Partial unique index for settings: `create unique index on settings(key) where active`.
- All jsonb payload columns: no schema enforcement in DB; zod-validate at the application boundary.
- Timezone handling: store timestamptz UTC everywhere; compute send windows in app code from lead/company IANA tz.
