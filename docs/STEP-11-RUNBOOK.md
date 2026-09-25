# Sending Infrastructure Runbook

**Owner:** Amir · **Created:** 2026-08-23 · **Rewritten:** 2026-09-21 (Session 3) · **Revised:** 2026-09-21 (Session 4) · **Recorded as built:** 2026-09-25 (Session 10)
**Type:** manual setup task — not a Claude Code unit.
**Implements the purchase side of:** `09-build-plan-v2.md` §4.

> **Renamed from "Step 11 — Sending Infrastructure Runbook".** The old 15-step plan is superseded by `09-build-plan-v2.md`. The sending code that used to be "step 11" is now units **U3–U6**.

**The one thing that matters:** warmup is a calendar clock, not an effort clock. Nothing here shortens it.

**What changed in the Session 3 rewrite:** Day 0 used to be a single shopping trip. It is now **two clocks**, because they have different optimal timing. Buying the domains early is free upside; buying Instantly early just burns subscription on idle inboxes.

**What changed in the Session 4 revision:** the domains were bought on 2026-09-21, but only registration and the 301 redirects were done. That turned out not to be a shortcut — **clock A asked for DKIM, and DKIM is generated in Google Workspace Admin, which clock B buys.** Clock A could never have delivered "full DNS". So all DNS authentication moved to clock B, and clock B moved **one unit earlier, to the start of U2**, to pay for it. Arithmetic in `09-build-plan-v2.md` §2.

| Clock | What | When |
|---|---|---|
| **A** | Two sending domains + 301 redirects | ✅ **Done 2026-09-21** |
| **B** | Instantly + four mailboxes + MillionVerifier credits **+ all DNS authentication** | ✅ **Bought 2026-09-24**, warmup running — open items in §E |

---

## A. ✅ Done 2026-09-21 — domains and redirects

Domains are cheap, and domain age is a deliverability input that only accrues with time — so they were bought first, and their age is already accruing.

What was **not** done here, and could not have been: the DNS authentication records. DKIM comes out of Google Workspace Admin, and Google Workspace is bought in clock B. Those records live in §B now.

### A.1 The two sending domains

Registrar: Namecheap (already in use).

> **Do not use `zyndix.com` or any subdomain for cold send.** This is a hard rule in `CLAUDE.md`.
>
> ⚠️ **Correction to the previous version of this file**, which said the rule was "already enforced by a code guard in `stages/send.ts`". **It is not. There is no `stages/send.ts`.** The normalized guard, its explicit allowed-sender list and its no-override rule all arrive at **U5**, and U5's DoD is what verifies them — including rejecting `zyndix.com`, `mail.zyndix.com`, `ZYNDIX.COM`, a trailing-dot form, a deep subdomain and a whitespace-padded form. Until U5 ships, the rule is enforced by you, not by code.
>
> ✅ **Shipped 2026-09-25 (U5, Session 11):** `src/lib/sending/guard.ts` blocks `zyndix.com` and every subdomain (normalized, no override). The allow-list is a code constant: `zyndixhq.com`, `getzyndix.com`. Preflight refuses with `blocked_sender_domain` / `sender_not_allowed`. `pnpm test:sending` covers the whole sub-table.

Criteria used: `.com` only, pronounceable, obviously related to Zyndix but not identical, no hyphens, no numbers.

| # | Domain | 301 → `zyndix.com` |
|---|---|---|
| 1 | `zyndixhq.com` | ✅ live |
| 2 | `getzyndix.com` | ✅ live |

> These two domains are the literal contents of U5's allowed-sender list, and U5's DoD asserts that the guard accepts them. Recorded 2026-09-24; also in `06-build-progress.md` §1.

### A.2 Root redirect — done

Each sending domain's root 301s to `https://zyndix.com`. A domain that sends mail but resolves to nothing is a recognised spam pattern.

---

## A-deferred. DNS and authentication — moved to §B.0

Everything below was in §A.2 until 2026-09-21. It is now **§B.0**, executed on purchase day, because DKIM cannot be generated before Google Workspace exists.

One piece of free margin if you want it: **MX, SPF and DMARC do not need Workspace** and could be set today at zero cost. Only DKIM and the tracking CNAME are genuinely blocked. Doing them early buys nothing but slack against a propagation surprise — the operator's call, not a requirement.

---

## B. At the start of U2 (≈ day 7) — Instantly, mailboxes, credits, DNS

**Why this timing.** FIRST SEND READY is the end of U6, ≈ day 33. Warmup wants 14 days minimum, 21 better. Buying at the start of U2 puts warmup at ≈ **days 9–33 — about 24 days**. Purchase day now carries the DNS work as well as the mailboxes and the Instantly connection, so budget about two days for it, including DKIM propagation and clicking *Start authentication*. Buying earlier wastes subscription on idle inboxes; buying later leaves finished code waiting on a clock nothing can shorten. Full arithmetic in `09-build-plan-v2.md` §2.

### B.0 DNS and authentication — both domains *(do this first)*

> **As built (2026-09-25).** The two domains ended up on **different providers**, so they have different records. `dig` on 2026-09-25:
>
> | | `zyndixhq.com` — Google Workspace | `getzyndix.com` — Microsoft 365 |
> |---|---|---|
> | MX | `1 smtp.google.com.` | `0 getzyndix-com.mail.protection.outlook.com.` |
> | SPF | `v=spf1 include:_spf.google.com ~all` | `v=spf1 include:spf.protection.outlook.com -all` |
> | DKIM | `google._domainkey` TXT published | `selector1._domainkey` → `selector1-getzyndix-com._domainkey.zyndix.q-v1.dkim.mail.microsoft.` and `selector2` likewise — **both resolve** to `v=DKIM1` keys |
> | DMARC | `v=DMARC1; p=none; rua=mailto:dmarc@zyndix.com; pct=100; adkim=r; aspf=r` | ✅ added via dmarcly (Session 11): `v=DMARC1; p=none; rua=mailto:…@ag.dmarcly.com; ruf=mailto:…@fo.dmarcly.com; sp=none;` — **exactly one** `_dmarc` TXT on 1.1.1.1, 8.8.8.8 and both authoritative NS |
> | `track` CNAME | not set — not needed (§B.4) | not set — not needed (§B.4) |
>
> **Still open for `getzyndix.com`:** re-run mail-tester on both getzyndix mailboxes now that DMARC exists. The Google records below apply to `zyndixhq.com` only; the M365 equivalents are shown in the table.
>
> Verify the DMARC record count (there must be exactly one):
> ```bash
> dig +short TXT _dmarc.getzyndix.com @dns1.registrar-servers.com | grep -c DMARC1   # expect 1
> ```

Do this **first on purchase day**, as soon as the Workspace mailboxes exist. Everything else here can wait; the DKIM clock cannot.

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

The tracking CNAME comes last — its target is shown by Instantly, so it waits for §B.4.

### B.1 Instantly — Hypergrowth ($97/mo)

> **As built: Instantly Growth**, bought 2026-09-24 (live `plan_id pid_g_v2`). This supersedes the Hypergrowth recommendation below (`06` §5, 2026-09-25). The API v2 works on Growth. Whether Growth can *create* webhooks is unproven — check at the start of U6.

Growth at $47 covers the real volume (25–50 sends/week for months). Hypergrowth buys A/B testing, premium support and headroom. Since budget is not the binding constraint and deliverability support matters when something breaks mid-campaign, take Hypergrowth. Every tier includes unlimited inboxes and unlimited warmup — you are not paying for inbox count.

Skip: SuperSearch credits (you have Apollo), Instantly CRM (you have Attio), AI Sales Agent (your engine *is* the agent — that is the case study).

### B.2 Four mailboxes

> **As built (2026-09-25)** — this supersedes the table below:
>
> | Domain | Tenant | Mailbox | Licence |
> |---|---|---|---|
> | `zyndixhq.com` | Google Workspace (own tenant) | `amir@` | licensed |
> | `zyndixhq.com` | Google Workspace (own tenant) | `ingrida@` | licensed |
> | `getzyndix.com` | Microsoft 365 Business Basic (own tenant; admin account unlicensed) | `amir@` | licensed |
> | `getzyndix.com` | Microsoft 365 Business Basic (own tenant; admin account unlicensed) | `ingrida@` | licensed |
>
> **Same local parts on both domains.** A lead must therefore keep **one** sending mailbox for its whole sequence and never rotate mid-sequence: a follow-up from `amir@getzyndix.com` after a first touch from `amir@zyndixhq.com` looks like a different sender with the same name. Enforced in code at U5 (`09` §U5).

Two per domain. Google Workspace Business Starter, ~€6–7 per mailbox/month. **Use real human names matching real people. Do not invent personas.**

| Domain | Mailbox | Display name |
|---|---|---|
| Domain A | `amir@` | Amir Ebadi |
| Domain A | `a.ebadi@` | Amir Ebadi |
| Domain B | `ingrida@` | Ingrida Šilobrit |
| Domain B | `i.silobrit@` | Ingrida Šilobrit |

Each mailbox needs a profile photo and a full signature with the Zyndix name, address and a working link to `zyndix.com`. An empty-profile sender is a spam signal.

### B.3 MillionVerifier credits

> **As built:** account holds **495 free credits** (2026-09-25) — enough for testing. Top up before sending volume.

Pay-as-you-go, ~$37 for a starter block. No subscription. The key is already in `MILLIONVERIFIER_API_KEY`; this is topping up the balance that U5's preflight will spend.

### B.4 Custom tracking domain

> **Decision 2026-09-25 (Session 11): NOT NEEDED — no custom tracking domain.** Opens are not used as a signal (brief §8), so there is nothing to track. Instantly workspace settings: **"Disable Open Tracking" ON**, **"Always send first email as text-only" ON**, link tracking off. Each sender campaign (`scripts/instantly-sender-campaigns.ts`) also sets `open_tracking:false`, `link_tracking:false`, `text_only:true` and `first_email_text_only:true`, and `--verify` reads them back. The instructions below are kept for the record only; **do not add the CNAME**. `06` §5.

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

> **As built:** all four mailboxes connected to Instantly; warmup started **2026-09-24** (19:31–20:52 UTC per Instantly's `timestamp_warmup_start`). Live check 2026-09-25: all four warmup active, health score 100.
>
> **Daily limit (Session 11).** The operator set the daily campaign limit to **1** on all four as a safety net until the first send. The API reads **`daily_limit=4`** on all four. Check it in the UI, then re-read with `pnpm tsx scripts/live-instantly.ts --accounts`. `enable_slow_ramp` is on for the zyndixhq accounts and off for the getzyndix ones.
>
> **Sender campaigns (Session 11).** There is one **draft** campaign per mailbox (`zx-sender-<mailbox>`), with no leads and never activated. They exist so each lead stays pinned to one sender. U6 activates only the one used in the live drill.

| Setting | Value |
|---|---|
| Warmup emails/day | 20 → 40, ramped over the full period |
| Reply rate | 30% |
| Weekend activity | ON (warmup only) |
| **Daily send limit** | **0 until U6** |
| Duration | 14 days minimum, **~24 as scheduled here** (≈ days 9–33) |

Checking it daily changes nothing. Re-run mail-tester on all four around day 28 (≈ U5): any score that dropped during warmup means something is wrong, and you want to find it before U6's live drill, not during it.

---

## C. While it warms — the work that does not depend on it

U2 through U6 are being built in this window, so the engine side is covered. These are the non-code items that are pure upside:

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

**Clock A — done 2026-09-21**
- [x] Two sending domains purchased
- [x] Both domains 301 to `zyndix.com`
- [x] Domain names recorded in §A.1 above and in `06-build-progress.md` §1 — `zyndixhq.com`, `getzyndix.com`

**Clock B — bought 2026-09-24**
- [x] `zyndixhq.com`: MX, SPF, DKIM, DMARC verified by `dig` (2026-09-25) — §B.0
- [x] `getzyndix.com`: MX, SPF, DKIM, DMARC resolve by `dig` — DMARC added via dmarcly, exactly one record (Session 11) — §B.0
- [x] Instantly active — **Growth**, not Hypergrowth (§B.1)
- [x] Four mailboxes live (`amir@`, `ingrida@` on each domain) — photos and signatures **not recorded**
- [x] MillionVerifier credits: 495 free, enough for testing — top up before volume
- [x] ~~Tracking CNAME live on both domains~~ — **not needed** (decision 2026-09-25): open tracking OFF, link tracking OFF, first email text-only — §B.4
- [x] All four mailboxes score ≥9/10 on mail-tester — **9.6/10 each** (operator-reported)
- [ ] `getzyndix.com` mailboxes re-tested as **authenticated** on mail-tester (first test: "You're not fully authenticated"; DKIM had just been enabled; DMARC absent then, present since Session 11)
- [x] Warmup running (started 2026-09-24)
- [ ] Instantly account daily limit matches the intended 1 — **API reads 4** (Session 11), operator to check
- [x] One draft sender campaign per mailbox, `--verify` passing (Session 11)
- [ ] Day-28 re-test passed

**Parallel**
- [ ] 20 Phase 0 messages sent, replies logged
- [ ] 4 testimonial requests sent

**Code** — tracked in `06-build-progress.md` §2, not here
- [ ] U3 scheduler · U4 Instantly adapter · U5 send stage + guards · U6 webhooks + stop rules 🚩
