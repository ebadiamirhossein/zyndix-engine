# Zyndix Outbound Engine

Outbound pipeline for Zyndix — Next.js App Router, Supabase, typed integrations.

## Quickstart

1. `pnpm install`
2. Copy `.env.local.example` → `.env.local` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `CRON_SECRET`.
3. Run `supabase/migrations/0000_ping.sql` once in the Supabase SQL editor.
4. `pnpm tsx scripts/ping.ts` — should print the inserted row and exit 0.
5. `pnpm build` — production type-check and compile.

**Planning docs:** Read all six files in `/docs` (`01-PRD.md` through `06-build-progress.md`) before each build step. Cursor prompts reference them by step.
