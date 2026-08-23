# Claude Code — Session 1: Reconcile build state

**How to use:** open Claude Code in the `zyndix-engine` repo root, paste everything between the `---` markers as a single message. Do not run this in the website repo.

**Why this session exists:** the tracker in `06-build-progress.md` shows every step as not started, but the master handoff records steps 1–10 as built and verified, and the build plan's backlog contains findings that could only come from live runs (Lee & Associates parked out-of-ICP, Stephan Group scored 52, `fantasticfrank.co` returned no pages to the cheerio crawler). Something is out of date. Before any new code is written, the tracker has to match reality — otherwise every estimate from here starts from a false baseline.

**Prerequisite:** copy `07-build-log.md` and `STEP-11-RUNBOOK.md` into `/docs`, and replace `CLAUDE.md` with the block from `CLAUDE-md-addition.md`. Do that before pasting.

---

Read `/docs/01-PRD.md` through `/docs/07-build-log.md` before doing anything. The most recent entry in `07-build-log.md` explains why this session exists.

Your job this session is **reconciliation only. Write no new features.**

## 1. Establish what actually exists

Inspect the repo and report the real state of build steps 1–15 from `05-build-plan.md`:

- `supabase/migrations/` — which tables from `02-database-schema.md` have migrations, and which are missing
- `src/lib/stages/` — which stage workers exist (source, enrich, qualify, verify, draft, send, classify)
- `src/lib/integrations/` — which integration clients exist (apollo, apify, anthropic, neverbounce/millionverifier, instantly, attio, calendly, telegram)
- `src/lib/scheduler/` — does `ledger.ts` or `windows.ts` exist yet
- `src/app/api/` — which routes exist (cron, webhooks, dashboard)
- `scripts/` — which `test-*.ts` scripts exist
- `src/lib/state.ts` and `src/lib/settings.ts` — present and complete?

For each of the 15 steps, classify it as **built / partial / missing**, and say what evidence you used. "The file exists" is weaker evidence than "the file exists and its test script passes" — be explicit about which you have.

## 2. Verify what you can, safely

Run, in this order:

```
pnpm install
pnpm build
```

Then run only the **free, read-only** test scripts — ones that read Supabase or check local logic. `scripts/ping.ts` and any settings/state-machine tests are safe.

**Stop and ask me before running anything that:**
- spends Apollo reveal credits, Apify actor runs, or Anthropic tokens
- sends any email or Telegram message
- writes to Attio

List those scripts and what each would cost, and wait for my answer. Do not run them on your own judgement.

Report which verifications passed, which failed, and paste the actual output for failures.

## 3. Check the environment without exposing it

Confirm which variables from `03-architecture.md` §7 are present in `.env.local`. **Report presence and absence only — never print a value, not even partially, and never write one into a doc or commit.** Flag any that are missing and say which step they block.

## 4. Correct the docs

- Rewrite the step tracker tables in `06-build-progress.md` to match what you found. Where the handoff and the repo disagree, the repo wins — note the disagreement in the notes column.
- Fill in the prerequisites checklist in §1 of that file from actual evidence (a key present in `.env.local` means that prerequisite is done).
- Leave step 8 (Attio) marked as deliberately deferred — that was an operator decision, not an oversight.
- Add the three known issues from the build plan backlog into §6 (issues/blockers) so they stop living in a backlog list: the JS-rendered site crawler failure, the ~20% qualification rate versus the 25-contacts/week target, and the `QUALIFY_MIN_SCORE` threshold question.

## 5. Log it

Append a Session 1 entry to the top of the Sessions section in `07-build-log.md`, using the template in that file. Include the verification output, anything you found that contradicts the docs, and a specific next action.

## Definition of done

- A step-by-step built/partial/missing table, with evidence stated for each
- `pnpm build` result reported
- Free test scripts run, results reported; credit-spending scripts listed and **not** run
- Env var presence reported, no values exposed
- `06-build-progress.md` reflects reality
- `07-build-log.md` has a Session 1 entry

## Do not

- Write new features, refactor, or "improve" anything you find
- Implement Step 11 — it needs Instantly, sending domains, and 14 days of warmup that have not started
- Change any prompt, migration, or the `zyndix.com` send guard
- Widen the ICP or touch `QUALIFY_MIN_SCORE` — flag them, don't change them

If you find something broken that takes under five minutes to fix and blocks the build (a bad import, a missing type export), fix it and note it in the log. Anything larger: report it and stop.

---

## Git

```bash
git checkout -b docs/reconcile-build-state
git add docs/ CLAUDE.md
git commit -m "docs: reconcile build tracker with actual repo state

- Add 07-build-log.md as the append-only session journal
- Add STEP-11-RUNBOOK.md (sending infrastructure setup)
- Rewrite CLAUDE.md with working rules and end-of-session log discipline
- Correct 06-build-progress.md step tracker against verified repo state
- Move known issues from build-plan backlog into the issues log

Tracker previously showed all steps unstarted while steps 1-10 were
built and verified. Repo state is now the source of truth."
git push -u origin docs/reconcile-build-state
```

Merge to `main` once you've read the reconciliation report and agree with it.

---

## After this session

**Session 2 does not start until Day 0 of the runbook is done** — two sending domains bought, Instantly Hypergrowth active, four mailboxes live, DNS verified, warmup running. Step 11's definition of done requires an approved touch to actually send through a warm inbox; there is nothing to test against until that infrastructure exists.

Use the 14 warmup days for Phase 0 (20 manual Lithuanian messages) and the four testimonial requests. I'll write the v2 architecture doc — LinkedIn lane with `linkedin_senders` toggles, next-best-action policy, multi-channel cadence, dashboard — in the same window.
