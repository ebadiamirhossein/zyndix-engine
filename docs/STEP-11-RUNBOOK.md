# Sending Infrastructure Runbook

**Owner:** Amir · **Created:** 2026-08-23 · **Rewritten:** 2026-09-21 (Session 3)
**Type:** manual setup task — not a Claude Code unit.
**Implements the purchase side of:** `09-build-plan-v2.md` §4.

> **Renamed from "Step 11 — Sending Infrastructure Runbook".** The old 15-step plan is superseded by `09-build-plan-v2.md`. The sending code that used to be "step 11" is now units **U3–U6**.

**The one thing that matters:** warmup is a calendar clock, not an effort clock. Nothing here shortens it.

**What changed in this rewrite:** Day 0 used to be a single shopping trip. It is now **two clocks**, because they have different optimal timing. Buying the domains early is free upside; buying Instantly early just burns subscription on idle inboxes.

| Clock | What | When |
|---|---|---|
| **A** | Two sending domains + full DNS | **Now** |
| **B** | Instantly + four mailboxes + MillionVerifier credits | **Start of U3** (≈ day 11) |

---

## A. Now — domains and DNS

Domains are cheap, and domain age is a deliberability input that only accrues with time. Doing the DNS now is also what lets clock B wait until U3 and still finish warmup on schedule: on purchase day only the mailboxes and the Instantly connection remain.

### A.1 Buy two sending domains

Registrar: Namecheap (already in use).

> **Do not use `zyndix.com` or any subdomain for cold send.** This is a hard rule in `CLAUDE.md`.
>
> ⚠️ **Correction to the previous version of this file**, which said the rule was "already enforced by a code guard in `stages/send.ts`". **It is not. There is no `stages/send.ts`.** The normalized guard, its explicit allowed-sender list and its no-override rule all arrive at **U5**, and U5's DoD is what verifies them — including rejecting `zyndix.com`, `mail.zyndix.com`, `ZYNDIX.COM`, a trailing-dot form, a deep subdomain and a whitespace-padded form. Until U5 ships, the rule is enforced by you, not by code.

Criteria: `.com` only, pronounceable, obviously related to Zyndix but not identical, no hyphens, no numbers.

Candidates (check availability, pick two): `zyndixhq.com` · `getzyndix.com` · `tryzyndix.com` · `zyndixagency.com` · `zyndixteam.com`

Record the two you buy in `06-build-progress.md` §1. They go into U5's allowed-sender list.

### A.2 DNS and authentication — both domains

DNS at Cloudflare (consistent with `zyndix.com`) or Namecheap. Be consistent.

**MX (Google Workspace)**
```
Type: MX   Host: @   Value: smtp.google.com   Priority: 1
```

**SPF** — one record per domain. Never two; two breaks SPF entirely.
```
Type: TXT   Host: @   Value: v=spf1 include:_spf.google.com ~all
```

**DKIM** — Google Workspace Admin → Apps → Google Workspace → Gmail → Authenticate email. Generate a **2048-bit** key, publish the TXT record, then click **Start authentication**. It is not active until you click that button. This is the step people skip.

**DMARC** — start permissive, tighten later.
```
Type: TXT   Host: _dmarc   Value: v=DMARC1; p=none; rua=mailto:dmarc@zyndix.com; pct=100; adkim=r; aspf=r
```
Move to `p=quarantine` after 30 days of clean reports. Not before — a strict policy on a young domain with a misconfigured record silently kills your mail.

**Root redirect** — point each sending domain's root at `https://zyndix.com` with a 301. A domain that sends mail but resolves to nothing is a recognised spam pattern.

**Verify before moving on**
```bash
DOMAIN=zyndixhq.com   # repeat for the second domain

dig +short MX    $DOMAIN
dig +short TXT   $DOMAIN                 # expect exactly one v=spf1 record
dig +short TXT   google._domainkey.$DOMAIN
dig +short TXT   _dmarc.$DOMAIN
```

The tracking CNAME cannot be added yet — its target comes from Instantly, so it belongs to clock B.

---

## B. At the start of U3 (≈ day 11) — Instantly, mailboxes, credits

**Why this timing.** FIRST SEND READY is the end of U6, ≈ day 33. Warmup wants 14 days minimum, 21 better. Buying at the start of U3 puts warmup at ≈ days 12–33 — about 21 days, landing exactly on U6's DoD. Buying earlier wastes subscription on idle inboxes; buying later leaves finished code waiting on a clock nothing can shorten. Full arithmetic in `09-build-plan-v2.md` §2.

### B.1 Instantly — Hypergrowth ($97/mo)

Growth at $47 covers the real volume (25–50 sends/week for months). Hypergrowth buys A/B testing, premium support and headroom. Since budget is not the binding constraint and deliverability support matters when something breaks mid-campaign, take Hypergrowth. Every tier includes unlimited inboxes and unlimited warmup — you are not paying for inbox count.

Skip: SuperSearch credits (you have Apollo), Instantly CRM (you have Attio), AI Sales Agent (your engine *is* the agent — that is the case study).

### B.2 Four mailboxes

Two per domain. Google Workspace Business Starter, ~€6–7 per mailbox/month. **Use real human names matching real people. Do not invent personas.**

| Domain | Mailbox | Display name |
|---|---|---|
| Domain A | `amir@` | Amir Ebadi |
| Domain A | `a.ebadi@` | Amir Ebadi |
| Domain B | `ingrida@` | Ingrida Šilobrit |
| Domain B | `i.silobrit@` | Ingrida Šilobrit |

Each mailbox needs a profile photo and a full signature with the Zyndix name, address and a working link to `zyndix.com`. An empty-profile sender is a spam signal.

### B.3 MillionVerifier credits

Pay-as-you-go, ~$37 for a starter block. No subscription. The key is already in `MILLIONVERIFIER_API_KEY`; this is topping up the balance that U5's preflight will spend.

### B.4 Custom tracking domain

Instantly → Settings → Custom Tracking Domain. Take the CNAME target it shows and add, on both domains:
```
Type: CNAME   Host: track   Value: <value shown in Instantly>
```
Verify with `dig +short CNAME track.$DOMAIN`.

**Tracking policy for this engine:**
- **Open tracking: ON**, through the custom domain. Note brief §8: opens are *diagnostic and may be unreliable*; they must not alone trigger aggressive follow-up or be reported as interest.
- **Link tracking: OFF.** Wrapped links are a deliverability tax, and a clean `zyndix.com/free-audit` carries more trust unwrapped than a redirect URL does.

### B.5 Gate before warmup

Send one email from each of the four mailboxes to the address at **mail-tester.com**.

**Every mailbox scores ≥ 9/10. Do not start warmup below 9.** Fix and retest — a mailbox that starts warmup misconfigured spends three weeks building a bad reputation instead of a good one.

### B.6 Turn on warmup, then leave it alone

| Setting | Value |
|---|---|
| Warmup emails/day | 20 → 40, ramped over the full period |
| Reply rate | 30% |
| Weekend activity | ON (warmup only) |
| **Daily send limit** | **0 until U6** |
| Duration | 14 days minimum, ~21 as scheduled here |

Checking it daily changes nothing. Re-run mail-tester on all four around day 28 (≈ U5): any score that dropped during warmup means something is wrong, and you want to find it before U6's live drill, not during it.

---

## C. While it warms — the work that does not depend on it

U3 through U6 are being built in this window, so the engine side is covered. These are the non-code items that are pure upside:

1. **Phase 0 — 20 manual warm Lithuanian messages, sent by hand.** The highest-value item in the project that depends on nothing. The writer prompt has zero few-shot examples, which means plausible-but-generic copy is its default failure mode. Twenty real messages produce twenty real hypothesis/evidence pairs and real replies; the best five get promoted into `writer_prompt_email` as v8 before the engine ever sends.
2. **Send the four testimonial requests** — Fonderis, ScholarCert, PulseConf, Loveko. Drafts exist. Fifteen minutes, pending since late July.
3. **Confirm Apollo credit balance and the MillionVerifier key.** Both get hit hard at U5.

---

## D. First live send settings (U6)

| Setting | Value |
|---|---|
| Sends per mailbox per day | **15** |
| Total daily capacity | 60 |
| Ramp | +5 every 4 days, ceiling 30/mailbox |
| Days | Tue / Wed / Thu |
| Window | 08:30–11:00 recipient local |
| Auto-pause | bounce rate >3% or any spam complaint |

Start at 15. Transcripts say 30–40/day/inbox is the safe ceiling *for a mature inbox*. A three-week-old one is not mature. **Warmup is not immunity.**

U6's DoD requires the live drill to send to an **operator-owned mailbox, never a prospect**, before anything else goes out. See `09-build-plan-v2.md` U6.

---

## E. Definition of done

**Clock A — now**
- [ ] Two sending domains purchased and recorded in `06-build-progress.md` §1
- [ ] MX, SPF, DKIM (authentication *started*), DMARC verified by `dig` on both domains
- [ ] Both domains 301 to `zyndix.com`

**Clock B — at U3**
- [ ] Instantly Hypergrowth active
- [ ] Four mailboxes live with photos and signatures
- [ ] MillionVerifier credits topped up
- [ ] Tracking CNAME live on both domains; link tracking OFF, open tracking ON
- [ ] All four mailboxes score ≥9/10 on mail-tester
- [ ] Warmup running with daily send limit 0
- [ ] Day-28 re-test passed

**Parallel**
- [ ] 20 Phase 0 messages sent, replies logged
- [ ] 4 testimonial requests sent

**Code** — tracked in `06-build-progress.md` §2, not here
- [ ] U3 scheduler · U4 Instantly adapter · U5 send stage + guards · U6 webhooks + stop rules 🚩
