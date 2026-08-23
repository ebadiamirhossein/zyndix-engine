# Step 11 — Sending Infrastructure Runbook

**Owner:** Amir · **Created:** 2026-08-23 · **Type:** manual setup task (not a Cursor/Claude Code step)
**Purpose:** unblock the outbound engine. Steps 1–10 are built and idle. This runbook makes them able to send.

**The one thing that matters:** warmup is a calendar clock, not an effort clock. Nothing here shortens it. Start Day 0 tonight and first cold send lands ~6 September. Start Day 0 in two weeks and it lands ~20 September. There is no version of this where waiting is cheaper.

---

## Day 0 — Purchases (60–90 minutes)

### 0.1 Buy two sending domains

Registrar: Namecheap (already in use). **Do not use `zyndix.com` or `email.zyndix.com` for any cold send — hard rule, already enforced by a code guard in `stages/send.ts`.**

Pick two lookalikes. Criteria: `.com` only, pronounceable, obviously related to Zyndix but not identical, no hyphens, no numbers.

Suggested pairs (check availability, pick any two):
- `zyndixhq.com`
- `getzyndix.com`
- `tryzyndix.com`
- `zyndixagency.com`
- `zyndixteam.com`

Record the two you buy in §5 of `06-build-progress.md`.

### 0.2 Buy Instantly

**Plan: Hypergrowth ($97/mo).**

Honest note: Growth at $47 would cover your actual volume (25–50 sends/week for months). Hypergrowth buys A/B testing, premium live support, and headroom you won't hit this year. Since budget isn't the constraint and deliverability support matters when something goes wrong mid-campaign, take Hypergrowth. Every tier includes unlimited inboxes and unlimited warmup — you are not paying for inbox count.

Skip for now: SuperSearch credits (you have Apollo), Instantly CRM (you have Attio), AI Sales Agent (your engine *is* the agent — that's the case study).

### 0.3 Buy four mailboxes

Two per domain. Google Workspace Business Starter, ~€6–7 per mailbox/month.

Use real human names, matching real people. Do not invent personas.

| Domain | Mailbox | Display name |
|---|---|---|
| Domain A | `amir@` | Amir Ebadi |
| Domain A | `a.ebadi@` | Amir Ebadi |
| Domain B | `ingrida@` | Ingrida Šilobrit |
| Domain B | `i.silobrit@` | Ingrida Šilobrit |

Each mailbox needs: profile photo, full signature with Zyndix name + address + working link to `zyndix.com`. An empty-profile sender is a spam signal.

### 0.4 Buy MillionVerifier credits

Pay-as-you-go, ~$37 for a starter block. No subscription. API key goes in `MILLIONVERIFIER_API_KEY`.

---

## Day 0+1 — DNS and authentication

Do all of this for **both** domains. DNS at Cloudflare (consistent with `zyndix.com`) or at Namecheap — either is fine, just be consistent.

### 1.1 MX (Google Workspace)

```
Type: MX   Host: @   Value: smtp.google.com   Priority: 1
```

### 1.2 SPF

```
Type: TXT   Host: @   Value: v=spf1 include:_spf.google.com ~all
```

One SPF record per domain. Never two — that breaks SPF entirely.

### 1.3 DKIM

Google Workspace Admin → Apps → Google Workspace → Gmail → Authenticate email.
Generate a **2048-bit** key, publish the TXT record it gives you, then click **Start authentication**. It is not active until you click that button — this is the step people skip.

### 1.4 DMARC

Start permissive, tighten later:

```
Type: TXT   Host: _dmarc   Value: v=DMARC1; p=none; rua=mailto:dmarc@zyndix.com; pct=100; adkim=r; aspf=r
```

Move to `p=quarantine` after 30 days of clean reports. Not before — a strict policy on a young domain with a misconfigured record silently kills your mail.

### 1.5 Domain redirect

Point each sending domain's root at `https://zyndix.com` with a 301. A domain that sends mail but resolves to nothing is a recognised spam pattern. Cloudflare Redirect Rule or Namecheap URL redirect — either works.

### 1.6 Custom tracking domain

In Instantly → Settings → Custom Tracking Domain, take the CNAME target it displays and add:

```
Type: CNAME   Host: track   Value: <value shown in Instantly>
```

**Tracking policy for this engine:**
- **Open tracking: ON** (through the custom domain). Your next-best-action logic needs open events.
- **Link tracking: OFF.** Wrapped links are a deliverability tax and your only link is a clean `zyndix.com/free-audit` — it carries more trust unwrapped than a redirect URL does.

### 1.7 Verify before proceeding

```bash
DOMAIN=zyndixhq.com   # repeat for the second domain

dig +short MX    $DOMAIN
dig +short TXT   $DOMAIN                 # expect one v=spf1 record
dig +short TXT   google._domainkey.$DOMAIN
dig +short TXT   _dmarc.$DOMAIN
dig +short CNAME track.$DOMAIN
```

Then send one email from each of the four mailboxes to the address at **mail-tester.com**.

**Gate: every mailbox scores ≥ 9/10. Do not start warmup below 9.** Fix and retest — a mailbox that starts warmup misconfigured spends 14 days building a bad reputation instead of a good one.

---

## Days 1–14 — Warmup (background) + Phase 0 (your actual work)

### 2.1 Turn on warmup

Connect all four mailboxes in Instantly, enable warmup on each:

| Setting | Value |
|---|---|
| Warmup emails/day | 20 → 40, ramp over the full period |
| Reply rate | 30% |
| Weekend activity | ON (during warmup only) |
| Daily send limit | **0 until day 14** |
| Duration | 14 days minimum, 21 is better |

Then leave it alone. Checking it daily changes nothing.

### 2.2 Do these while it warms

These are the reason the two weeks aren't wasted:

1. **Phase 0 — 20 manual warm Lithuanian messages, sent by hand.** This is the highest-value item in the entire project and depends on nothing. The writer prompt currently has zero few-shot examples, which means it will produce plausible-but-generic copy — the precise failure mode of the 1,000-email campaign. Twenty real messages produce twenty real hypothesis/evidence pairs and real replies. Best five get promoted into `writer_prompt_email` as settings v2 before the engine ever sends.
2. **Send the four testimonial requests** (Fonderis, ScholarCert, PulseConf, Loveko). Drafts already exist. Pending since late July. Unblocks Clutch, GoodFirms, site testimonial slots, and the "small agency" objection. Fifteen minutes of work.
3. **Confirm Apollo credit balance** and MillionVerifier key work — both get hit hard on day 14.

### 2.3 Day 12 checkpoint

Re-run mail-tester on all four mailboxes. Any score that dropped during warmup means something is wrong; find it before you send.

---

## Day 14 — Code and first send

Only now does this become a Claude Code task. One session, one prompt:

> Implement Step 11 per `05-build-plan.md`: `scheduler/ledger.ts` (atomic slot grant), `scheduler/windows.ts` (timezone-aware send windows with jitter), `integrations/instantly.ts`, and `stages/send.ts` with double suppression check and the zyndix.com domain guard. Ship `scripts/test-send.ts`. Read docs 01–06 first. Update `06-build-progress.md` and append a session entry to `07-build-log.md` when done.

**Definition of done (from the build plan, unchanged):**
- An approved touch sends through a warm inbox, inside its send window
- `capacity_ledger.used` increments atomically
- A quota-exhausted send queues for the next day rather than failing
- The guard **refuses** a `zyndix.com` send account in a test — verify this one explicitly
- Suppression is checked twice: at source and immediately before send

### First live send settings

| Setting | Value |
|---|---|
| Sends per mailbox per day | **15** |
| Total daily capacity | 60 |
| Ramp | +5 every 4 days, ceiling 30/mailbox |
| Days | Tue / Wed / Thu |
| Window | 08:30–11:00 recipient local |
| Auto-pause | bounce rate >3% or any spam complaint |

Start at 15. The transcripts you collected say 30–40/day/inbox is the safe ceiling *for a mature inbox* — a 14-day-old one is not mature. Warmup is not immunity.

---

## Definition of done for this runbook

- [ ] Two sending domains purchased and recorded
- [ ] Instantly Hypergrowth active
- [ ] Four mailboxes live with photos and signatures
- [ ] SPF, DKIM (authentication *started*), DMARC, MX, tracking CNAME verified by `dig` on both domains
- [ ] Both domains 301 to zyndix.com
- [ ] All four mailboxes score ≥9/10 on mail-tester
- [ ] Warmup running, daily send limit 0
- [ ] 20 Phase 0 messages sent, replies logged
- [ ] 4 testimonial requests sent
- [ ] Day 12 re-test passed
- [ ] Step 11 code shipped, DoD verified, `06-build-progress.md` and `07-build-log.md` updated

---

## What comes after

Steps 12–15 (webhooks, reply classifier, orchestrator, dashboard v0), then the v1 gate: 10 leads end-to-end, one clean week of sends, zero unhandled errors.

The v2 scope — LinkedIn lane, next-best-action policy, multi-channel cadence, dashboard — gets specced during the warmup window and built after the v1 gate passes. An engine that has never sent an email has no outcome data to make those systems smarter than a rules table.
