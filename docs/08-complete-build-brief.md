# Zyndix Engine — Complete Build Brief for Claude Code

**Final implementation recommendation · 9 September 2026**

## Owner's direction — read first

Complete the full Zyndix Engine. The owner explicitly prefers a complete application over the earlier minimal-engine proposal. Build the working features, interfaces, integrations, tests and operational controls described below; do not stop at a plan, a CLI-only prototype, placeholder screens or a research-only release.

Zyndix's main commercial direction is **custom business software and products, AI agents, and automation**. CRM and marketing integrations are supporting capabilities. The engine must support multiple industries and offers, not permanently restrict Zyndix to CRM projects, UK events or US real estate.

**New central requirement:** a permanent **Knowledge & Imports** section where the team can upload Markdown handoffs, product documentation, case studies and other files at any time. The engine should understand approved information, retrieve it when relevant, and decide whether to recommend an existing product, cite a relevant project, propose a custom build, or use no asset at all.

Example: upload a Scholarcert handoff. For a conference organizer with a relevant certificate problem, the engine may recommend Scholarcert. For a business needing a different custom platform, it may use Scholarcert as an example of Zyndix's development capability. For an unrelated prospect, it should omit Scholarcert.

### What must be finished

1. Protected operator dashboard.
2. Persistent uploads, searchable knowledge, structured product/case-study records and version control.
3. Prospect sourcing/import, research, evidence-based qualification and relevant offer/product matching.
4. Campaigns and coordinated email/LinkedIn journeys with review, quotas and stop rules.
5. Instantly, Telegram, Calendly, Heyreach and Attio integration paths.
6. Reply handling, next-action recommendations, meeting and sales pipeline tracking.
7. Background processing, monitoring, cost reporting, recovery and end-to-end verification.

This file supersedes the limited-scope and deferred-feature recommendations in `03-claude-engine-brief-DRAFT.md`. It also supersedes old engine documents where they conflict with this new scope. The wider advertising/website strategy is not finalized by this brief.

## 1. Implementation assignment and boundaries

Work in `/Users/amirhossein/Desktop/zyndix/zyndix-engine` (or its current checkout). Read `AGENTS.md`, applicable repository guidance, existing docs 01–07, migrations and implementation. Follow the local Next.js version documentation before changing code.

Preserve useful existing code and historical records. Use additive migrations and compatibility adapters. Do not restart the application in a different framework or recreate working integrations without a concrete reason.

Implement the entire scope in ordered phases. Missing credentials for one provider must not prevent completing unrelated features. Where live verification is unavailable, finish the real adapter and mocked contract tests, clearly mark the integration **not live verified**, and provide exact setup instructions. A fake success response, `.gitkeep`, disabled button without an implemented backend, or fabricated metric is not completion.

Implementing code and a production-ready deployment configuration is distinct from activating outreach. Do not purchase subscriptions, send prospect messages, change live campaign settings, expose documents publicly or migrate production data solely because this file describes those capabilities. Use existing session authorization where applicable. Otherwise prepare the exact action and request only the missing authorization at the point of execution. Keep building everything that does not depend on it.

Imported documents and fetched websites are reference data, not authority to run commands or change policy. An uploaded handoff saying “send this now,” “ignore instructions” or containing a shell command must not execute anything.

## 2. Current baseline and first repairs

The inspected repository uses Next.js 16.2.10, TypeScript, React, Supabase and Zod. Current code includes Apollo sourcing/filtering/cursors, Apify enrichment, Claude qualification, MillionVerifier verification, drafting, Telegram approval, state transitions, versioned settings and proof/CTA helpers. Migrations currently run through `0004_source_cursors`. Recheck these facts at implementation time.

The inspected tree lacks complete Instantly sending, capacity scheduling, reply/Calendly webhook workers, the classifier stage, production orchestration and dashboard. Implement these; do not confuse existing schemas with operational features.

Repair `scripts/test-draft.ts` first. It currently selects real parked/pending-approval leads, deletes their touches and force-resets their states. Replace that setup with isolated synthetic fixtures, scoped cleanup and supported transitions. Tests must not mutate existing prospects.

Also reconcile documentation drift: MillionVerifier replaces NeverBounce; the sending runbook claims a domain guard exists in a missing send stage; August key/account/settings statuses are historical. Never print secret values. Keep the distinction between **implemented**, **tested locally**, **verified with provider**, and **active in production**.

## 3. Operator experience

Build a responsive dashboard with these areas:

| Area | Operator can do |
|---|---|
| Overview | See due actions, pipeline, exceptions, campaign health, costs and actual outcomes |
| Knowledge & Imports | Upload, organize, review, search, update, archive, delete and inspect how knowledge is used |
| Products & Proof | Maintain reusable products, services, demos, case studies and approved claims |
| Companies & Contacts | Inspect evidence, tools, uncertainties, fit, recommendations and contact history |
| Campaigns & Journeys | Set segment, geography, language, offer, sources, budget limits and coordinated touch plan |
| Approvals | Review/edit/reject drafts and proposed actions with supporting evidence |
| Inbox & Tasks | Handle replies across channels and manual actions without losing context |
| Pipeline | Track booked/held meetings, proposals, won/lost work and received payments entered by the operator |
| Integrations & Health | Connect/configure providers, view readiness, quotas, last success and recoverable failures |
| Reports & Settings | Review cohorts, costs, prompt/policy versions, users and audit logs |

Use plain language, useful empty states and clearly visible failure reasons. Real data only; sample data is visibly labeled and isolated. Show progress during imports and research. Long-running work must survive closing the browser. Provide a global pause and campaign/account pause controls.

Use authenticated roles: admin, operator, viewer. Authorize every server operation; hiding buttons is insufficient. This is a Zyndix internal tool, not a multi-tenant SaaS/billing project.

## 4. Knowledge & Imports — required full feature

### 4.1 Upload and organize

Support repeated drag-and-drop and file-picker uploads, including batches. Also support pasted text and an explicitly selected public URL as a source. Adding a new product or document must not require a code deployment.

**Required extraction:** `.md`, `.txt`, text-based `.pdf`, `.docx`, `.csv`, `.json`. Support screenshots/scanned PDFs through an explicit OCR/vision-processing option with a cost estimate. Unsupported formats may be stored and downloaded but must show **stored only — not searchable by the engine**. Never silently imply every file type was understood.

Provide folders/collections or tags, title, document type, linked product/project, language, source date, owner and visibility. Separate two workflows:

- **Knowledge import:** documentation, product handoffs, proof, processes and reference material.
- **Prospect import:** CSV contacts/companies with mapping, preview, deduplication and recipient checks. A knowledge CSV must not automatically become an outreach list.

Store originals in a private Supabase Storage bucket and metadata in Postgres. Downloads require authorization and short-lived signed URLs. Files must persist across deployments. Configure file-size, page and batch limits; show them before upload. Validate actual file type, constrain parsers, reject dangerous active content, and prevent execution/rendering of imported scripts. Sanitize Markdown previews and disable raw active HTML.

For URL import/crawling, permit only appropriate public HTTP(S) destinations; reject loopback, private/link-local networks, cloud metadata endpoints and unsafe redirects. Do not let a supplied URL become server-side access to internal systems.

### 4.2 Ingestion lifecycle

Use observable states, for example:

`uploaded → extracting → extracted → indexing → ready_for_review → published`

Also support `failed`, `stored_only`, `archived`, `deleting`, and recoverable partial failures. Show status and reason separately for extraction, indexing and review. Preview extracted text before publication. Failed OCR, encrypted PDFs and empty files must produce actionable errors.

Create checksums for duplicate detection. Exact re-upload should offer reuse; a changed document can become a new immutable version of the same source. Reprocessing must not duplicate facts/chunks. The current published version is explicit; drafts must not supersede it accidentally. Never activate a partially indexed revision.

Retain source locations in extracted text: Markdown heading/line range, PDF page, DOCX section/paragraph, CSV row, or JSON path. Preserve tables and meaningful structure. Splitting text must retain product identity and document/version metadata.

### 4.3 Information use and publication

Document visibility and claim permission are separate:

- **Internal reference:** available to authorized analysis, but raw internal details cannot appear in prospect messages.
- **Approved for outreach:** specified reviewed facts, claims, excerpts and public links may be used externally.
- **Restricted:** retained for authorized storage/access; excluded from model processing and retrieval unless deliberately reclassified by an admin.

Default uploads to internal reference and unpublished. Extract suggested records into a review screen. Permit batch approval of selected facts rather than forcing a click for every paragraph. Uploading a file never automatically approves all its contents for outreach.

Screen for obvious credentials and sensitive personal data before model processing; flag/quarantine findings and offer redacted reprocessing. Do not claim automated detection catches everything. Do not send whole private handoffs to email providers, analytics tools, Telegram messages or public URLs.

A model may use an approved public summary of an internal product handoff. It must not disclose database architecture, keys, customer lists, confidential prices or internal problems from that handoff.

### 4.4 Search, update and removal

Provide keyword search and semantic retrieval with filters for project/product, type, language, approval, version, freshness and access. Use Postgres full-text plus vector retrieval where supported by the existing Supabase environment. Keep embedding model/version/dimension in configuration; do not mix incompatible indexes. A clearly labeled full-text fallback must remain usable during vector outages or reindexing.

Provide **Ask the library**: answers with source/version/location citations, explicitly indicating missing or conflicting information. Library Q&A cannot send messages or change campaign settings. Apply access filters before retrieval, not just in the UI.

Replacing, archiving or deleting knowledge must invalidate affected cached recommendations and queued drafts. Retain sent-message audit history only as permitted by the retention policy; deletion must remove original blobs, extracted content, chunks/embeddings and applicable derived personal data. Keep minimal lawful suppression/audit metadata without silently retaining deleted content in snapshots.

Show “used in these recommendations/drafts” so the operator can understand the effect of changes.

## 5. Structured product, service and proof records

Do not rely on unstructured retrieval alone. Extract and maintain editable records linked to document versions and approved source facts.

### Product/capability record

- Name, owner/relationship, verified public URL and status: live, beta, demo, planned or retired.
- What it does, problems solved, ideal users, relevant industries and workflows.
- Features/integrations supported by the source, prerequisites and limitations.
- Unsuitable use cases and when custom work would be needed.
- Available deployment/customization options, where actually documented.
- Public demo/screenshots, approved summary, proof references.
- Price/currency/source-date only if documented; whether public use is approved.
- Source references, verification owner/date, review date and active version.

### Case-study/proof record

- Project, Zyndix's contribution, relationship: client work, previous employment, own product, demo.
- Original problem, delivered solution, stack where relevant, and evidence assets.
- Capability facts separately from measured outcomes.
- Each number with definition, scope, period, source and permitted wording.
- Testimonial text/attribution/use permission if available.
- Relevant offers/industries and public-sharing permissions.

### Service/offer record

- Buyer/problem, deliverables, prerequisites, boundaries, discovery questions, approximate effort/internal pricing assumptions, proof links and CTA options.

Legacy `proof_points` must remain readable while migrating to structured records. Do not seed unsupported customer outcomes from polished marketing copy. Register Scholarcert as an owner-identified built product, with features confirmed from approved sources. Veniopass may be registered by name/URL, but do not invent its features from the domain or infer them from Scholarcert. Let later handoff imports populate it.

New industry tags, products and offers must be manageable in the interface rather than hard-coded enumerations.

## 6. Relevant matching — the Scholarcert requirement

For each prospect, the engine should consider **four distinct choices**:

1. Recommend an existing product that solves the prospect's stated/observed need.
2. Cite a relevant case study as proof of Zyndix's capability.
3. Propose discovery for a custom solution or AI agent, optionally illustrated by analogous work.
4. Use no product/case study, or decide there is no justified outreach opportunity.

The goal is useful fit, not mentioning a product in every message. An industry match alone is insufficient. Existing software that adequately solves the problem should not be ignored to force a custom build.

Recommended decision output:

```json
{
  "action": "recommend_product",
  "asset_id": "scholarcert-record-id",
  "asset_version": 2,
  "use_as": "product_recommendation",
  "matched_need": "Certificate creation and verification",
  "prospect_evidence_ids": ["evidence-id"],
  "knowledge_fact_ids": ["approved-fact-id"],
  "confidence": "medium",
  "unknowns": ["Current certificate workflow and annual volume"],
  "reason_to_mention": "A relevant certificate need is documented; features match.",
  "reason_not_to_mention": null,
  "discovery_question": "How are certificates created and verified today?",
  "next_action": "draft_for_review"
}
```

This is a contract example, not an actual prospect or current Scholarcert assessment. Validate the schema and source IDs. Expose the reasons to the operator. Always allow `no_relevant_asset` and `insufficient_evidence`; there is no mandatory top recommendation.

Retrieve a small candidate set using the prospect's problem, workflow and constraints; filter by approval/status/permissions; then rank for relevance, evidence strength, limitations and freshness. Do not insert the entire library into each prompt. Record the retrieved versions and decision reasons.

Default to at most one relevant product or proof point in an initial email. Follow-ups may use a different relevant asset when it adds information. A library update should trigger a review task, not automatically email previously contacted people.

### Required examples/tests

| Scenario | Expected behavior |
|---|---|
| Conference organizer explicitly describes manual certificate administration | Consider Scholarcert as a product if its approved capabilities meet the need |
| Event company has no certificate-related signal | Do not recommend Scholarcert solely because it runs events; ask a justified question or omit |
| Buyer needs a bespoke partner portal | Scholarcert may illustrate platform-building capability; do not claim it is that portal |
| Unrelated business with an unrelated need | Omit Scholarcert |
| Prospect already has a suitable certificate platform | Do not manufacture a replacement need |
| Imported file describes a future feature | Do not claim that feature exists today |
| Sources disagree about pricing/features | Surface conflict and hold the disputed claim for review |
| Product retired or permission withdrawn | Exclude it and re-evaluate affected queued drafts |

## 7. Prospect sourcing and research

Complete Apollo sourcing and CSV/manual import. Preserve deduplication by normalized domain/provider IDs and contacts without collapsing distinct people. Allow an operator to merge records with an audit trail. Check suppression during source and again before any send.

Research at company level first and reuse appropriately across its contacts. Use public company pages, services, products, relevant pricing, careers and allowed external sources. Enrich selected contacts only after basic fit. Configure crawl depth, freshness and per-company cost limits. Inspect current provider capabilities and plans before assuming an API field or source is available.

Evidence must distinguish **observed**, **inferred**, **prospect-confirmed**, **contradicted** and **unknown**, with source URL, timestamp, excerpt and confidence. Public scripts can identify visible widgets; they cannot reliably identify private CRM setup, actual response times, company revenue or unmet need. Failed crawls are missing information, not evidence of a problem.

A qualification should state buyer fit, one specific problem hypothesis, evidence, unknowns, discovery question, relevant offer/product choices and a disqualification/hold reason. Keep confirmed customer answers above earlier model hypotheses. Do not loosen qualification merely to create more sendable leads.

## 8. Campaigns and coordinated journeys

Build multiple configurable campaigns with segment, country, language, audience criteria, selected offers/knowledge collections, sender accounts, sources, quotas, costs, schedule, objective, CTA and approval policy. Do not silently replace existing live segment settings with the earlier UK/events proposal.

Support concurrent campaigns but prevent accidental simultaneous sequences to the same company/person. Store a stable campaign/offer/prompt/knowledge version snapshot per enrollment. Separate cold, warm/referral, inbound and product-interest cohorts.

Journey steps may include research, email, waiting, approved follow-up, LinkedIn connection/message, manual engagement task, human reply, booking invitation, meeting preparation, hold and close. Branch on confirmed events and explicit policies; do not let an LLM issue arbitrary tool calls.

Use aggregate cross-channel contact limits and cooldowns. Silence is not permission to continually add channels. Opens/clicks are diagnostic and may be unreliable; they must not alone trigger aggressive follow-up or claims of interest.

Default email cadence may be three touches around days 0/4/10, editable per campaign. This is a starting configuration, not a universal best practice. All first touches require approval. A fully reviewed sequence can execute within its approved scope; materially changed content, recipient, offer, referenced facts or channel requires renewed review. Low-confidence replies and negotiations route to a human.

The next-action model proposes a structured action, reason, evidence, confidence, time, cost and approval requirement. A deterministic policy layer chooses allowed execution. `do_nothing`, `hold`, `research_more` and `close` must be first-class outcomes.

## 9. Integrations — implement the real paths

| Provider | Required integration |
|---|---|
| Apollo | Company/contact sourcing, selective reveals, pagination/cursors, deduplication, rate and credit limits |
| Apify | Configurable public-web research, asynchronous run tracking, caching, failure handling and cost reporting |
| Anthropic | Structured extraction, qualification, matching, drafting, reply classification and digest; validated outputs and usage tracking |
| MillionVerifier | Verification status/date, invalid/catch-all handling and re-verification policy |
| Instantly | Configured account/campaign discovery as supported, reviewed enrollment/sending, stop/pause, events, reconciliation and health |
| Telegram | Approval/edit/reject/snooze, selected alerts, operator authentication and duplicate/stale action protection |
| Calendly | Bookings, cancellations/reschedules, contact matching, sequence stop, preparation tasks; manual held/no-show recording when unavailable through API |
| Heyreach | Implement supported campaign/lead/event/stop operations, sender configuration and reconciliation; provide manual LinkedIn task mode |
| Attio | Complete company/person/deal sync with external IDs, source-of-truth rules, retries and conflict visibility |

Read **current official documentation** when implementing every provider. Record which plan/permissions are required and which requested operations are unavailable. Never invent endpoints, webhook events, delivery guarantees, or assume third-party API access makes a platform action permitted.

LinkedIn prohibits unauthorized automation and scraping; low daily limits do not make it permitted. Complete the Heyreach adapter and tests as part of this build, show that operational risk in integration setup, and default its external execution to off/manual until the owner explicitly enables the reviewed route. Do not create fake engagement, evade restrictions or promise a safe quota. An unsupported action such as a particular automatic like operation must become a clear manual task, not a fake completed step. [LinkedIn policy](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions).

Secrets belong server-side in the existing secret/environment configuration. The UI displays configured/missing/verified status, not stored key values. No credentials in prompts, browser bundles, exports or logs.

## 10. Reliable sending and stop handling

Choose one owner of timing for each channel. If Instantly/Heyreach owns a provider campaign sequence, the engine enrolls once and coordinates it; it must not independently send the same follow-ups. If the engine owns each step, verify supported provider mechanics. Document the choice and aggregate limits across providers.

Preflight immediately before execution must verify: authenticated approval bound to content and recipient versions; active campaign; recipient/channel eligibility; no suppression/reply/booking/hold; current verification; allowed healthy sender; available quota; working-hours/timezone window; no duplicate operation or company conflict.

Implement normalized protection for `zyndix.com` and its subdomains as cold sender domains. Maintain an explicit allowed sender list. Do not treat bought/pre-warmed domains, a mail-test score or a fixed warmup period as guaranteed readiness.

Use atomic reservations, worker leases, stable idempotency keys, provider IDs and an outbox/reconciliation process. A timeout after provider acceptance is an **uncertain outcome**, not permission to resend. Quota accounting includes reserved, accepted, failed and reconciled attempts with documented recovery semantics.

Receive webhooks with signature/secret verification, persist them before processing, deduplicate and tolerate reordering. An inbound reply freezes the relevant outreach before LLM classification. Explicit opt-outs/complaints update durable suppression immediately and stop queued activity across channels; respect person-level versus company-wide scope. Meetings also stop outreach. Cancellation/rescheduling must not automatically restart cold contact.

Expose unmatched contacts/events and failed stops in an exception queue with escalation. A periodic reconciliation job detects missed events and state divergence. When reliable stop/reply processing is unavailable, pause affected sends. Already-dispatched messages may be impossible to retract; represent that honestly.

Jurisdiction/channel eligibility is a versioned policy record with recipient classification, data basis, notices, source/review date and opt-out handling. Do not implement “GDPR legitimate interest” as blanket permission to email every European business. Review current sender and recipient rules before activating a country. Budget flexibility is not an instruction to spend without campaign limits.

## 11. Inbox, meetings and revenue

Consolidate inbound messages, related account context and next tasks. Show a chronological history across channels, evidence, approvals, sends and meetings. Interested/question/objection replies produce reviewed response drafts; do not automatically negotiate price or commit to delivery. Unknown/ambiguous rejections hold for review rather than becoming automatic recontact after 60 days.

Create meeting briefs using prospect evidence, applicable product/proof, unanswered questions and the conversation. Record booked, held, qualified, no-show, proposal, won/lost, contract value, currency, received cash, delivery effort and loss reason. Distinguish operator-reported values from provider facts and model estimates. Unknown is null, not zero.

Attio remains a human CRM view; Supabase stores engine operations. Define field ownership: engine owns enrichment/approvals/send state, while approved manual sales-stage updates can flow back from Attio without overwriting suppression or safety holds. Detect conflicts rather than last-write-wins overwriting decisions.

## 12. Reports, costs and learning

Dashboard and weekly digest must show unique companies/people contacted, attempts, provider acceptance, delivery where known, bounces, human/positive replies, meetings booked/held/qualified, proposals, wins, received cash, acquisition cost and time-to-next-step. Follow-ups do not count as new prospects. OOO/neutral replies and opens are not positive intent.

Break down by campaign, country, offer, asset used, channel, prompt version and cohort. Keep signed value, received cash and profit estimates distinct. Do not sum mixed currencies without an explicit exchange-rate basis. Show denominators and sample sizes alongside rates.

Track provider and model usage by job, company, document import and campaign, with actual versus estimated cost. Support configured per-run/day/month limits, alerts and holds. No automatic credit purchases. Caches should avoid paying repeatedly to research unchanged companies or embed unchanged documents.

Learning creates reviewable suggestions: which hypotheses were confirmed, which assets helped, which messages caused confusion, and proposed prompt/offer changes. Do not automatically publish new claims or promote a “winning” prompt from tiny samples. Changes need version history, comparison and rollback.

## 13. Database and job architecture

Reuse existing companies, leads, qualification/history, touches, sequences, settings, events, suppression, accounts and capacity structures. Add normalized entities where lifecycle and constraints require them, approximately:

| Entity | Purpose |
|---|---|
| knowledge_documents / document_versions | Source metadata, ownership, visibility, original object paths and immutable versions |
| knowledge_chunks / knowledge_facts | Searchable passages and reviewed facts with source locations/permissions |
| catalog_items / catalog_versions / evidence links | Products, services, case studies, approved claims and their provenance |
| campaigns / campaign_enrollments | Configured acquisition cohorts, pinned versions and company/contact membership |
| recommendations | Candidate ranking, chosen action, citations, reasons and operator override |
| jobs / outbox / integration_sync records | Durable ingestion/research/sending/sync work, leases, retries and uncertain outcomes |
| opportunities / outcomes | Commercial pipeline where existing lead_events alone is insufficient |

These are design responsibilities, not a mandate to duplicate existing tables. Resolve exact names and relationships after inspecting migrations; document the mapping. Add foreign keys, uniqueness, indexes and transactions for critical invariants. Enable RLS/private storage policies and enforce server-side authorization. Index access restrictions must match document permissions.

Do not run long crawls/OCR/imports inside a single upload request. Use durable jobs with bounded workers, timeout recovery, capped retries, backoff, progress and dead-letter/manual-review states. Validate hosting runtime and scheduler limits. A browser session or in-memory timer is not the job system. Feature flags and integration availability must not conceal incomplete implementation.

## 14. Delivery phases — complete all of them

1. **Reconcile and repair:** inspect actual state, fix destructive testing, update schema/build plan and establish authentication/test fixtures.
2. **Knowledge system:** private storage, upload/extraction, review/versioning, catalog, search and citations.
3. **Research and matching:** prospect import/source, evidence, product/offer/proof relevance and reviewed drafts.
4. **Campaign execution:** journey policy, approvals, Instantly, quotas, stop controls, replies and Calendly.
5. **Complete integrations and commercial workflow:** Heyreach/manual mode, Attio, pipeline, costs, digest and monitoring.
6. **Full verification and handoff:** migrations, end-to-end tests, UI verification, recovery drills and deploy/setup instructions.

Implement in manageable increments but do not treat an intermediate phase as the requested final product. Keep a status matrix and continue through independent work if a live-provider check is blocked. Do not use the older “wait for first client before building these features” recommendation to omit this scope.

## 15. Required verification and definition of done

Test important boundaries and outcomes, not just functions mirroring implementation:

- Import a synthetic Scholarcert-like Markdown handoff; review extracted facts; publish approved facts; retrieve with accurate source locations.
- Update the handoff without duplicates; show version differences; invalidate affected pending drafts; preserve permissible sent history.
- Import PDF/DOCX/CSV/JSON; handle malformed, encrypted, unsupported and OCR-needed inputs honestly.
- Confirm unauthorized users cannot access originals, search results, signed downloads, management actions or restricted model context.
- Reject prompt injection from uploaded Markdown and prospect websites; ensure private details never appear in outbound drafts.
- Run every matching scenario in section 6, including correct omission and product-versus-case-study distinction.
- Carry a synthetic prospect through source → research → matching → review → simulated send → reply stop → meeting → proposal → won outcome.
- Repeat with an opt-out, duplicate webhook, out-of-order events, provider timeout after acceptance, stale approval, worker crash and simultaneous quota reservation.
- Verify no response, wrong person, OOO, negative reply, booking, cancellation and reschedule policies.
- Verify coordinated email/LinkedIn stops, Attio conflict resolution, and reconciliation after provider downtime.
- Verify cost caps, campaign isolation, duplicate-company protection and knowledge deletion/index invalidation.
- Run build, type checking and relevant automated tests; inspect the actual dashboard flows at desktop and mobile sizes.
- Use mocked/sandbox providers and synthetic contacts first. Separately list live contract tests and their actual results. Never claim a mocked integration is live verified.

Final handoff must include working code, additive migrations, updated architecture/schema/PRD, sample non-sensitive imports, operator guide, configuration checklist without secrets, deployment/rollback instructions, test results and a module-by-module readiness table. Clearly distinguish code complete from production verification pending. No unexplained stubs.

**The owner should be able to upload a new product handoff tomorrow, approve what may be used, and have the engine make better prospect recommendations without changing code. That capability, plus the complete acquisition and sales loop, is the central acceptance criterion.**
