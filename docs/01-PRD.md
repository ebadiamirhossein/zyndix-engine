# Zyndix Outbound Engine — Product Requirements Document (PRD)

**Version:** 1.0 · **Date:** 2026-07-08 · **Owner:** Amir (Zyndix)
**Codename:** `zyndix-engine`

---

## 1. What this is

An autonomous-with-approval outbound system that finds companies matching Zyndix's ICP, enriches them with real context, uses Claude to qualify each one with a **specific problem hypothesis**, drafts personalized outreach, sends it through safe infrastructure, listens for replies, decides next actions, and books free-audit calls — while logging every outcome so the system improves weekly.

It is also a **product demo**: the engine itself is Zyndix's flagship case study ("the system that contacted you is the kind of system we build").

## 2. Why (problem statement)

- Zyndix's previous cold outreach (1,000 emails → 4–5 meetings → 0 clients) failed on **offer and audience**, not volume: generic "we do automation" messaging to people without felt pain.
- Manual prospecting doesn't scale past founder hours, and founder hours must go to delivery and warm outreach.
- **Core corrective principle (non-negotiable):** no lead is ever contacted without a named, evidence-backed problem hypothesis. The engine amplifies a specific message; it never sends a generic one.

## 3. Goals & success metrics

| Goal | Metric | v1 target (first 60 days) |
|---|---|---|
| Meetings | Free-audit calls booked from engine leads | ≥ 6 |
| Reply quality | Positive/neutral reply rate on first touches | ≥ 5% |
| Deliverability | Bounce rate / spam complaints | < 3% / ~0 |
| Learning | Weekly digest produced with per-segment stats | every Monday |
| Safety | Zero suspended inboxes / LinkedIn accounts | 0 incidents |

**Non-goals (v1):** auto-sending without human approval on first touches; multi-segment simultaneous launch; continuous signal monitoring of the whole database; ads conversion uploads (module designed, built when ads start); replacing warm local outreach (Phase-0/parallel track, done by hand).

## 4. Users

- **Amir** — operator: approves/edits drafts (Telegram), tunes prompts/ICP (dashboard), reviews weekly digest.
- **Ingrida** — secondary operator: same capabilities, LT-segment focus later.
- **The engine** (system user) — executes pipeline stages on cron.

## 5. The pipeline (functional requirements)

FR-1 **Source** — Pull companies + decision-maker contacts from Apollo API by active segment definition (stored in settings, editable). Dedupe against existing leads.

FR-2 **Enrich** — For each lead: Apify website crawl (homepage, services, contact, careers), Apify LinkedIn posts scrape (decision-maker, last 3–5 posts), Apify job-listings check (admin/coordinator/receptionist roles = manual-overload trigger). Store raw payloads in Supabase.

FR-3 **Qualify (Claude)** — Input: all enrichment. Output JSON: `fit_score (0–100)`, `segment`, `problem_hypothesis` (one specific, checkable claim), `evidence` (quotes/observations), `triggers[]`, `visible_tools[]` (detected from HTML: HubSpot, Calendly, Typeform, Intercom, GTM…), `disqualify_reason?`, `recommended_angle`. **Rule: no evidence → no hypothesis → lead parked, never contacted.**

FR-4 **Store & sync** — Everything in Supabase (system of record). Sync clean subset to Attio: person, company, deal stage, next action. Attio = human window; Supabase = brain.

FR-5 **Verify** — Email verification (NeverBounce/MillionVerifier API) before drafting. Invalid → park; catch-all → flag, lower send priority.

FR-6 **Draft (Claude)** — First touch ≤120 words: names THEIR problem in sentence one, one Zyndix proof point, free-audit CTA, no "we do automation" language. GDPR-appropriate footer for EU targets. Channel-aware (email vs LinkedIn variants).

FR-7 **Approve (Telegram)** — Draft delivered to Telegram bot with lead context; inline buttons ✅ send / ✏️ edit / ❌ kill / 💤 snooze. v1: ALL first touches require approval. Follow-ups auto-send after sequence approved once.

FR-8 **Send** — Instantly API (email; pre-warmed purchased domains only — zyndix.com and email.zyndix.com NEVER send cold). Heyreach API (LinkedIn) in Phase 3. Every send passes through the capacity ledger (see FR-11).

FR-9 **Listen** — Webhooks: Instantly (reply, bounce, open, spam complaint), Calendly (`invitee.created` → stage "Audit booked" + kill sequences), Heyreach (Phase 3). Reply kills sequence instantly.

FR-10 **Decide (Claude)** — Classify replies: interested / question / objection / not-now / negative / OOO / wrong-person. Propose next action; route to Telegram when human judgment needed.

FR-11 **Schedule & protect (capacity ledger)** —
- Per-inbox daily quotas: start 15/day (pre-warmed), ramp to 25–30/day max; 4 inboxes on 2 lookalike domains.
- LinkedIn (Phase 3): ~20 connects / ~25 messages per day per account, humanized hours.
- Send windows: recipient timezone, Tue–Thu 08:30–11:00 local prioritized, no weekends, ± random jitter.
- Cadence: touch 1 → +3d → +7d → +14d, stop after 4. Every touch adds value (touch 3 carries the Automation Gap PDF). Reply stops everything.
- Auto-pause inbox on bounce rate >3% or any spam complaint; Telegram alert.

FR-12 **Learn** — Outcome log per lead per touch. Weekly Monday digest (Telegram + dashboard): sent/opens/replies/meetings per segment, best/worst performing hypothesis angles, inbox health.

FR-13 **Settings (live-editable)** — ICP rubric, segment definitions, all prompts, cadence, capacity knobs stored versioned in Supabase; editable via dashboard (primary) and Telegram commands (quick); effective next lead, no deploy.

FR-14 **Dashboard** — Protected admin page: capacity controls, send windows, prompt/ICP editor with version history, pipeline stats, lead browser, inbox health.

FR-15 **Ads conversion module (designed now, built later)** — Free-audit form captures `gclid`/`fbclid`/UTMs into Supabase from day one. Upload of offline conversions (audit booked / deal won) to Google/Meta APIs is a later bolt-on, activated only when Amir calls for ads.

## 6. Segments & activation

ICP is a signal-based rubric (settings-stored, editable), not a fixed industry list. Recognized segments at launch: `us-realestate`, `lt-events`, `clinics-dental`, `professional-services`, `agencies`, `ecom-support`.

**Activation order: `us-realestate` first → `lt-events` second.** One segment active at a time until a segment produces ≥2 meetings or 4 weeks of data, then next activates. Both US and LT are first-class markets; activation is sequential for learning, not priority.

## 7. Compliance & safety requirements

- GDPR: legitimate-interest basis for B2B EU outreach; every email has identity + working opt-out; opt-outs recorded permanently in Supabase suppression table (checked at source stage). LinkedIn-scraped personal data: professional-public only, minimal storage, deletable on request.
- CAN-SPAM (US): accurate sender, physical address line, opt-out honored.
- LinkedIn automation (Phase 3) acknowledged ToS risk: Heyreach with conservative limits; LT warm outreach stays manual.
- Cold sending isolated to purchased lookalike domains with SPF/DKIM/DMARC verified before first send.

## 8. Human-in-the-loop policy

- v1: human approves every first touch.
- Graduation: a segment may move to auto-send on first touches only after ≥50 approved sends with <10% edit rate — operator decision, per segment.
- Replies classified `interested`/`question` always route to human.

## 9. Phasing

- **Phase 0 (parallel, manual):** 20 warm LT messages by hand; outputs become prompt ground truth.
- **Phase 1 (v1):** scaffold, schema, settings, Apollo pull (segment 1), Apify enrichment, Qualifier, Attio sync, verification, Writer, Telegram approval, Instantly send, reply webhook, stop-on-reply. Dashboard v0 (capacity + prompts + stats).
- **Phase 2:** reply classification loop, follow-up cadence automation, signal monitoring (re-scan existing leads), weekly digest automation.
- **Phase 3:** Heyreach LinkedIn lane, Calendly loop closure polish, multi-segment concurrency.
- **Phase 4:** ads conversion uploads (on Amir's call).

## 10. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Deliverability burn | Ledger quotas, ramp, verification, auto-pause, lookalike domains only |
| Generic messaging relapse | Evidence-required rule in Qualifier; approval gate; weekly digest surfaces reply rates per angle |
| LinkedIn account restriction | Phase-3 only, conservative limits, manual LT outreach unaffected |
| Prompt drift / regression | Versioned settings with history; digest ties versions to outcomes |
| Scope creep | Phasing table above is the contract; new ideas go to backlog section of build plan |

## 11. Open items

- Purchase 2 pre-warmed lookalike domains + 4 inboxes (Instantly) — Amir.
- Apollo plan/credits confirmation — Amir.
- NeverBounce vs MillionVerifier final pick (by price at signup) — Amir.
- Telegram bot token creation (@BotFather) — Amir, at build time.
