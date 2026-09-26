import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import {
  accountHealth,
  createInstantlyClient,
  INSTANTLY_BASE_URL,
  InstantlyError,
} from "../src/lib/integrations/instantly";
import { CAMPAIGN_STATUS_LABELS, label } from "../src/lib/integrations/instantly-types";
import { createTelegramClient } from "../src/lib/integrations/telegram";
import { createJobQueue } from "../src/lib/jobs/queue";
import { createRegistry } from "../src/lib/jobs/registry";
import { runWorker } from "../src/lib/jobs/worker";
import { type ReconcileDeps, runReplyPoll, polledReplyPayload } from "../src/lib/reconcile/core";
import { createCapacityLedger } from "../src/lib/scheduler/ledger";
import { ledgerDate, nextSendWindow } from "../src/lib/scheduler/windows";
import { approvalHash, buildApprovalSnapshot } from "../src/lib/sending/approval";
import { threadedSubject, type SendPolicy, type SendWindowsConfig } from "../src/lib/sending/preflight";
import { normalizeEmail } from "../src/lib/sending/suppression";
import { isValidTimeZone } from "../src/lib/sending/timezone";
import { createSettingsStore } from "../src/lib/settings/core";
import { addressList, enqueueSend, RECONCILE_JOB_TYPE, SEND_JOB_TYPE, type SendDeps } from "../src/lib/stages/send/core";
import { sendJobDefinitions } from "../src/lib/stages/send/jobs";
import { createStateStore } from "../src/lib/state/core";
import { type InstantlyWebhookDeps, processInstantlyEvent } from "../src/lib/webhooks/instantly";
import type { Database } from "../src/types/database";
import type {
  DatabaseWithCapacity,
  DatabaseWithJobs,
  DatabaseWithSending,
  DatabaseWithWebhooks,
} from "../src/types/database-extensions";
import type { LeadState } from "../src/types/enums";

// U6 Part 2 live drill (09 §U6, Session 14; re-test Session 16 as drill:s14b).
// One operator-owned recipient, one sender, fixed test text — never a
// prospect, never a generated draft.
//
// Session 16 recipient is a Gmail +alias of the Session 14 address (same
// inbox): the old drill lead 7fd018fa keeps the base address and is only ever
// read here (PREVIOUS_DRILL_RECIPIENT), never written.
//
//   --check                  read-only: sender, campaign + schedule, workspace
//                            leads for the recipient, health, open windows by zone
//   --fixture --tz <IANA>    DB: drill company + lead (sourced → pending_approval via lib/state)
//   --touch 1|2              DB: fixed-text touch, approved with the real binding
//   --activate | --pause     INSTANTLY WRITE: campaign 5392fcac only
//   --send <touchId>         SENDS MAIL through the real send stage (queue + worker)
//   --reconcile              runs a queued send.reconcile job for the drill, if any
//   --status                 read-only: the drill lead's rows
//   --verify-hash <touchId>  read-only: stored approval_hash vs the hash preflight recomputes
//   --lead-status            read-only: GET /leads/{id} for the drill enroll (status, domain_complete)
//   --emails                 read-only: GET /emails/{id} for the drill emails + To/Cc verdict
//   --poll                   runReplyPoll for this sender, GET /emails id comparison,
//                            then the polled reply replayed through processInstantlyEvent
//   --cancel-jobs            cancels queued jobs for the drill touches only
//
// Every write is guarded: recipient == DRILL_RECIPIENT, sender == DRILL_SENDER,
// lead tagged drill. Secrets are never printed.

const DRILL_RECIPIENT = "ebadiamirhoseineng+s14b@gmail.com";
/** Session 14 drill address (lead 7fd018fa). Read-only: attribution and stop_for_company checks. */
const PREVIOUS_DRILL_RECIPIENT = "ebadiamirhoseineng@gmail.com";
const DRILL_SENDER = "amir@zyndixhq.com";
const DRILL_CAMPAIGN = "5392fcac-8d29-432b-84ab-c9a50f626ab9";
const DRILL_DOMAIN = "drill-s14b.zyndix-drill.invalid";
const DRILL_TAG = "drill:s14b";
const SUBJECT = "Zyndix engine drill S14b";
const BODIES: Record<1 | 2, string> = {
  1: "Hi Amir,\n\nThis is a Zyndix engine drill (Session 16 / S14b, step 1): a fixed test message sent by the engine to an operator-owned mailbox. No action needed.",
  2: "Hi Amir,\n\nDrill follow-up (Session 16 / S14b, step 2), sent as a threaded reply to step 1. Please reply to this thread from Gmail to test the reply freeze.",
};
const MIN_SEND_MINUTES = 20;
const MIN_DRILL_MINUTES = 60;
const CANDIDATE_ZONES = [
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Halifax",
  "America/Sao_Paulo",
  "Atlantic/Azores",
  "Atlantic/Reykjavik",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Vilnius",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const raw = createServiceClient(url, key);
const baseDb = raw as SupabaseClient<Database>;
const sendDb = raw as unknown as SupabaseClient<DatabaseWithSending>;
const webhookDb = raw as unknown as SupabaseClient<DatabaseWithWebhooks>;
const state = createStateStore(baseDb);
const settings = createSettingsStore(baseDb);
const ledger = createCapacityLedger(raw as unknown as SupabaseClient<DatabaseWithCapacity>);
const queue = createJobQueue(raw as unknown as SupabaseClient<DatabaseWithJobs>);
const instantly = createInstantlyClient();
const telegram = createTelegramClient();

const s8 = (id: string | null | undefined): string => (id ? id.slice(0, 8) : "—");
const args = process.argv.slice(2);
const value = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

class DrillGuardError extends Error {}
function guard(ok: boolean, why: string): asserts ok {
  if (!ok) throw new DrillGuardError(`GUARD: ${why} — nothing written`);
}

async function getActiveSetting(k: string): Promise<{ version: number; value: unknown }> {
  const s = await settings.getActiveSetting(k as never);
  return { version: s.version, value: s.value };
}
const alert = (text: string) => telegram.sendAlert(text);

// ---------------------------------------------------------------------------
// Read-only Instantly diagnostics outside the typed client (Session 16)
// ---------------------------------------------------------------------------

/** POST is allowed only for list endpoints, which read. Nothing here mutates. */
const READ_ONLY_POSTS = new Set(["/api/v2/leads/list"]);

async function instantlyRead(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const method = body === undefined ? "GET" : "POST";
  guard(method === "GET" || READ_ONLY_POSTS.has(path), `read-only helper refuses POST ${path}`);
  const res = await fetch(new URL(path, INSTANTLY_BASE_URL), {
    method,
    headers: {
      Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

type InstantlyLeadRow = {
  id: string;
  email?: string;
  campaign?: string | null;
  status?: number;
  company_domain?: string;
  status_summary?: { domain_complete?: boolean; lastStep?: { from?: string; stepID?: string; timestamp_executed?: string } };
};

const LEAD_STATUS: Record<string, string> = { "1": "Active", "2": "Paused", "3": "Completed", "-1": "Bounced", "-2": "Unsubscribed", "-3": "Skipped" };

function describeInstantlyLead(l: InstantlyLeadRow): string {
  const last = l.status_summary?.lastStep;
  return (
    `${s8(l.id)} campaign=${s8(l.campaign ?? null)} status=${l.status ?? "?"}(${LEAD_STATUS[String(l.status)] ?? "?"}) ` +
    `domain_complete=${l.status_summary?.domain_complete ?? "—"} company_domain=${l.company_domain ?? "—"} ` +
    `lastStep=${last ? `${last.from ?? "?"}@${last.timestamp_executed ?? "?"}` : "none"}`
  );
}

/** Workspace-wide leads for an address (skip_if_in_workspace would turn an existing one into `uncertain`). */
async function workspaceLeads(email: string): Promise<{ status: number; matches: InstantlyLeadRow[] }> {
  const r = await instantlyRead("/api/v2/leads/list", { contacts: [email], limit: 10 });
  const items = ((r.json as { items?: InstantlyLeadRow[] } | null)?.items ?? []).filter((l) => normalizeEmail(l.email ?? "") === email);
  return { status: r.status, matches: items };
}

/**
 * The sender's Instantly budget today: campaign emails sent (accounts/analytics/daily)
 * against the account's daily_limit. Unknown is a stop, never "fine".
 *
 * Operator decision (Session 16): the gate applies to step 1 (the campaign
 * enroll) only. A step >= 2 goes out via emails/reply, which Instantly does not
 * cap by daily_limit: in Session 14 step 2 was accepted after 1/1 was used
 * (GET /emails shows it) and analytics still reports sent=1 for that day. For
 * a follow-up the numbers are printed and the send is not stopped — the
 * engine's capacity ledger is then the only cap (06 §6).
 */
async function senderBudget(
  accountId: string,
  dailyLimit: number | null | undefined,
  now: Date,
  scope: "step1" | "follow-up",
): Promise<boolean> {
  const day = now.toISOString().slice(0, 10);
  const q = new URLSearchParams({ start_date: day, end_date: day });
  q.append("emails", DRILL_SENDER);
  const r = await instantlyRead(`/api/v2/accounts/analytics/daily?${q.toString()}`);
  const rows = Array.isArray(r.json) ? (r.json as Array<{ date?: string; email_account?: string; sent?: number }>) : null;
  const mine = rows?.filter((x) => normalizeEmail(x.email_account ?? "") === DRILL_SENDER && (x.date ?? "").slice(0, 10) === day) ?? [];
  const sentToday = rows === null ? null : mine.reduce((sum, x) => sum + (x.sent ?? 0), 0);
  const engineDay = await ledger.getDay(accountId, ledgerDate(now));
  console.log(
    `sender budget ${day} (UTC date queried): instantly sent_today=${sentToday ?? "null"}` +
      `${rows !== null && mine.length === 0 ? " (no row returned for this date)" : ""} · daily_limit=${dailyLimit ?? "null"} · analytics HTTP ${r.status}`,
  );
  console.log(
    `  engine capacity_ledger ${ledgerDate(now)}: ` +
      (engineDay ? `quota=${engineDay.quota} used=${engineDay.used} reserved=${engineDay.reserved} accepted=${engineDay.accepted}` : "no row"),
  );
  console.log("  caveat: the spec does not state the analytics date's timezone; emails/reply is treated as not capped by daily_limit (Session 14 evidence)");
  if (scope === "follow-up") {
    console.log("  not gated: a step >= 2 goes out via emails/reply, which daily_limit does not cap (Session 16 decision)");
    return true;
  }
  if (sentToday === null || dailyLimit === null || dailyLimit === undefined) {
    console.log("  BUDGET UNKNOWN — stop and ask before any write");
    return false;
  }
  if (sentToday >= dailyLimit) {
    console.log(`  BUDGET STOP (step 1): sender at daily limit (${sentToday} >= ${dailyLimit}) — no write`);
    return false;
  }
  console.log(`  budget ok: ${dailyLimit - sentToday} left today`);
  return true;
}

// ---------------------------------------------------------------------------
// Windows: engine (recipient tz) and the Instantly campaign schedule
// ---------------------------------------------------------------------------

type CampaignSchedule = {
  schedules?: Array<{ name?: string; timing?: { from?: string; to?: string }; days?: Record<string, boolean>; timezone?: string }>;
  start_date?: string | null;
  end_date?: string | null;
};

function localParts(at: Date, timeZone: string): { weekday: number; minutes: number; text: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { weekday, minutes, text: `${parts.weekday} ${parts.hour}:${parts.minute}` };
}

const hm = (s: string | undefined): number => {
  const [h, m] = (s ?? "").split(":").map(Number);
  return (h ?? NaN) * 60 + (m ?? NaN);
};

/** Minutes left in an open campaign schedule slot at `at` (0 when closed). Instantly days: "0" = Sunday. */
function campaignMinutesLeft(schedule: CampaignSchedule | null, at: Date): number {
  let best = 0;
  for (const s of schedule?.schedules ?? []) {
    if (!s.timezone || !isValidTimeZone(s.timezone)) continue;
    const local = localParts(at, s.timezone);
    if (!s.days?.[String(local.weekday)]) continue;
    const from = hm(s.timing?.from);
    const to = hm(s.timing?.to);
    if (local.minutes >= from && local.minutes < to) best = Math.max(best, to - local.minutes);
  }
  return best;
}

function engineMinutesLeft(windows: SendWindowsConfig, timeZone: string, at: Date): number {
  const w = nextSendWindow(at, timeZone, windows);
  const inside = w.opensAt.getTime() <= at.getTime() && at.getTime() < w.end.getTime();
  return inside ? Math.floor((w.end.getTime() - at.getTime()) / 60_000) : 0;
}

async function campaignSchedule(): Promise<{ status: string; schedule: CampaignSchedule | null }> {
  const c = await instantly.getCampaign(DRILL_CAMPAIGN);
  const schedule = ((c as Record<string, unknown>).campaign_schedule ?? null) as CampaignSchedule | null;
  return { status: label(CAMPAIGN_STATUS_LABELS, c.status), schedule };
}

function vilnius(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Vilnius",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

// ---------------------------------------------------------------------------
// Loading the drill rows
// ---------------------------------------------------------------------------

async function sender() {
  const { data, error } = await sendDb.from("send_accounts").select("*").eq("identifier", DRILL_SENDER).single();
  if (error || !data) throw new Error(`load sender: ${error?.message}`);
  guard(data.instantly_campaign_id === DRILL_CAMPAIGN, `sender campaign is ${s8(data.instantly_campaign_id)}, expected ${s8(DRILL_CAMPAIGN)}`);
  return data;
}

async function drillLead() {
  const { data: company, error } = await baseDb.from("companies").select("*").eq("domain", DRILL_DOMAIN).maybeSingle();
  if (error) throw new Error(`load drill company: ${error.message}`);
  if (!company) return null;
  const { data: lead, error: leadError } = await sendDb.from("leads").select("*").eq("company_id", company.id).maybeSingle();
  if (leadError) throw new Error(`load drill lead: ${leadError.message}`);
  if (!lead) return null;
  guard(normalizeEmail(lead.email ?? "") === DRILL_RECIPIENT, "drill lead email is not the drill recipient");
  guard(company.segment === "drill", "drill company is not segment=drill");
  const { data: tag } = await baseDb
    .from("lead_events")
    .select("id")
    .eq("lead_id", lead.id)
    .eq("event", "drill_tag")
    .limit(1);
  guard((tag ?? []).length === 1, "drill lead has no drill_tag event");
  return { company, lead };
}

async function requireDrillLead() {
  const found = await drillLead();
  guard(found !== null, "no drill lead — run --fixture first");
  return found;
}

async function drillTouches(leadId: string) {
  const { data, error } = await sendDb.from("touches").select("*").eq("lead_id", leadId).order("created_at");
  if (error) throw new Error(`touches: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function check(): Promise<void> {
  const now = new Date();
  console.log(`=== drill-u6 --check (read-only) · now ${now.toISOString()} · Vilnius ${vilnius(now)} ===`);
  const account = await sender();
  console.log(
    `sender ${DRILL_SENDER} id=${s8(account.id)} health=${account.health} campaign=${s8(account.instantly_campaign_id)} ` +
      `ramp_started_on=${account.ramp_started_on ?? "null"} signature=${account.signature_text ? "set" : "MISSING"}`,
  );

  const policy = (await getActiveSetting("send_policy")).value as SendPolicy;
  const windowsSetting = await getActiveSetting("send_windows");
  const windows = windowsSetting.value as SendWindowsConfig;
  const liveAccount = await instantly.getAccount(DRILL_SENDER);
  const warmup = await instantly.getWarmupAnalytics([DRILL_SENDER]);
  const health = accountHealth(liveAccount, warmup.aggregate_data[DRILL_SENDER] ?? null, { minWarmupScore: policy.min_warmup_score });
  console.log(`instantly health verdict=${health.verdict} warmup_score=${health.warmupScore ?? "null"} (min ${policy.min_warmup_score})`);

  const { status, schedule } = await campaignSchedule();
  console.log(`campaign ${s8(DRILL_CAMPAIGN)} status=${status}`);
  for (const s of schedule?.schedules ?? []) {
    const days = Object.entries(s.days ?? {}).filter(([, on]) => on).map(([d]) => d).join(",");
    console.log(`  schedule "${s.name ?? ""}" tz=${s.timezone} days=[${days}] ${s.timing?.from}–${s.timing?.to}`);
  }
  const campaignLeft = campaignMinutesLeft(schedule, now);
  console.log(`  campaign schedule open now: ${campaignLeft > 0 ? `yes, ${campaignLeft} min left` : "NO"}`);

  // --check gates the start of the drill, i.e. the step-1 enroll.
  const budgetOk = await senderBudget(account.id, liveAccount.daily_limit, now, "step1");

  const current = await workspaceLeads(DRILL_RECIPIENT);
  console.log(`instantly workspace leads for recipient ${DRILL_RECIPIENT}: HTTP ${current.status} · ${current.matches.length} match(es)`);
  for (const l of current.matches) console.log(`  ${describeInstantlyLead(l)}`);
  // stop_for_company: the docs do not say whether a gmail.com reply completes later gmail.com leads.
  const previous = await workspaceLeads(PREVIOUS_DRILL_RECIPIENT);
  console.log(`instantly leads for the previous drill address (read-only): HTTP ${previous.status} · ${previous.matches.length} match(es)`);
  for (const l of previous.matches) console.log(`  ${describeInstantlyLead(l)}`);
  const domainComplete = previous.matches.some((l) => l.status_summary?.domain_complete === true);
  if (domainComplete) console.log("  FLAG: domain_complete=true on the previous drill lead — stop_for_company may block the alias");

  const { data: sup } = await baseDb.from("suppression_list").select("id").ilike("email", DRILL_RECIPIENT);
  const { data: domainSup } = await baseDb.from("suppression_list").select("id").is("email", null).ilike("domain", "gmail.com");
  console.log(`engine: gmail.com domain suppression rows=${(domainSup ?? []).length}`);
  const { data: others } = await baseDb.from("leads").select("id, state").ilike("email", DRILL_RECIPIENT);
  console.log(`engine: suppression rows=${(sup ?? []).length} · leads with recipient email=${(others ?? []).length}`);
  const existing = await drillLead().catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  console.log(`drill lead: ${existing === null ? "none yet" : typeof existing === "string" ? existing : `${s8(existing.lead.id)} state=${existing.lead.state} tz=${existing.lead.timezone}`}`);

  console.log(`\nwindows now (send_windows v${windowsSetting.version}; combined = min(engine, campaign)):`);
  const rows = CANDIDATE_ZONES.map((tz) => {
    const engine = engineMinutesLeft(windows, tz, now);
    return { tz, local: localParts(now, tz).text, engine, combined: Math.min(engine, campaignLeft) };
  }).sort((a, b) => b.combined - a.combined || b.engine - a.engine);
  for (const r of rows) {
    console.log(`  ${r.tz.padEnd(20)} ${r.local.padEnd(10)} engine=${String(r.engine).padStart(3)} min · combined=${String(r.combined).padStart(3)} min`);
  }
  const best = rows[0]!;
  if (!budgetOk) console.log("\nSTOP (step 1): sender budget is exhausted or unknown (above) — no write");
  if (best.combined >= MIN_DRILL_MINUTES) {
    console.log(`${budgetOk ? "\n" : ""}PICK ${best.tz}: ${best.combined} min left (≥ ${MIN_DRILL_MINUTES})${budgetOk ? "" : " — but budget STOP"}`);
    return;
  }
  console.log(`\nNO zone has ≥ ${MIN_DRILL_MINUTES} combined min now (best ${best.tz}: ${best.combined}).`);
  for (let t = now.getTime() + 15 * 60_000; t < now.getTime() + 8 * 86_400_000; t += 15 * 60_000) {
    const at = new Date(t);
    const cLeft = campaignMinutesLeft(schedule, at);
    if (cLeft < MIN_DRILL_MINUTES) continue;
    for (const tz of CANDIDATE_ZONES) {
      const combined = Math.min(engineMinutesLeft(windows, tz, at), cLeft);
      if (combined >= MIN_DRILL_MINUTES) {
        console.log(`NEXT workable: ${vilnius(at)} Vilnius (${at.toISOString()}) with ${tz}, ${combined} min`);
        return;
      }
    }
  }
  console.log("NEXT workable: none found in 8 days");
}

async function fixture(): Promise<void> {
  const tz = value("--tz");
  guard(Boolean(tz && isValidTimeZone(tz)), "--tz <IANA zone> required");
  guard((await drillLead()) === null, "a drill lead already exists");
  const { data: others } = await baseDb.from("leads").select("id").ilike("email", DRILL_RECIPIENT);
  guard((others ?? []).length === 0, "another lead already has the recipient email");

  const { data: company, error } = await baseDb
    .from("companies")
    .insert({ name: "ZX DRILL S14B", domain: DRILL_DOMAIN, segment: "drill", country: null, timezone: null })
    .select("id")
    .single();
  if (error || !company) throw new Error(`company: ${error?.message}`);
  const now = new Date().toISOString();
  const { data: lead, error: leadError } = await baseDb
    .from("leads")
    .insert({
      company_id: company.id,
      first_name: "Amir",
      last_name: "Drill S14b",
      email: DRILL_RECIPIENT,
      email_status: "valid",
      email_verified_at: now,
      timezone: tz,
      state: "sourced",
    })
    .select("id")
    .single();
  if (leadError || !lead) throw new Error(`lead: ${leadError?.message}`);
  await baseDb.from("lead_events").insert({
    lead_id: lead.id,
    event: "drill_tag",
    detail: { tag: DRILL_TAG, note: "U6 live drill fixture; operator-owned recipient; email_status asserted by operator, not verified" },
  });
  const path: Array<[LeadState, LeadState]> = [
    ["sourced", "enriching"],
    ["enriching", "qualifying"],
    ["qualifying", "qualified"],
    ["qualified", "verifying"],
    ["verifying", "drafting"],
    ["drafting", "pending_approval"],
  ];
  for (const [from, to] of path) await state.transition(lead.id, from, to, "drill_fixture", { tag: DRILL_TAG });
  console.log(`FIXTURE company=${s8(company.id)} lead=${s8(lead.id)} tz=${tz} state=pending_approval tag=${DRILL_TAG}`);
}

async function touch(): Promise<void> {
  const step = Number(value("--touch"));
  guard(step === 1 || step === 2, "--touch 1|2");
  const { lead } = await requireDrillLead();
  const account = await sender();
  const existing = await drillTouches(lead.id);
  guard(!existing.some((t) => t.step_no === step && t.direction === "outbound" && t.status !== "killed"), `step ${step} touch already exists`);
  if (step === 1) guard(lead.state === "pending_approval", `lead is ${lead.state}, expected pending_approval`);
  else guard(lead.state === "sent", `lead is ${lead.state}, expected sent`);

  const subject = step === 1 ? SUBJECT : threadedSubject(SUBJECT);
  const body = BODIES[step as 1 | 2];
  const { data: row, error } = await sendDb
    .from("touches")
    .insert({ lead_id: lead.id, step_no: step, channel: "email", direction: "outbound", status: "pending_approval", subject, draft_body: body, body: null, prompt_version: null, send_account_id: account.id })
    .select("id, step_no, channel, subject, prompt_version")
    .single();
  if (error || !row) throw new Error(`touch: ${error?.message}`);
  const snapshot = buildApprovalSnapshot({ ...row, body }, { id: lead.id, email: lead.email }, account);
  const { error: approveError } = await sendDb
    .from("touches")
    .update({
      body,
      status: "approved",
      approval_hash: approvalHash(snapshot),
      approval_snapshot: snapshot as never,
      approved_at: new Date().toISOString(),
      approved_by: "operator:drill-s14b",
    })
    .eq("id", row.id);
  if (approveError) throw new Error(`approve: ${approveError.message}`);
  if (step === 1) await state.transition(lead.id, "pending_approval", "approved", "approved", { touch_id: row.id, source: DRILL_TAG });
  console.log(`TOUCH step=${step} id=${row.id} subject="${subject}" approved (sender ${DRILL_SENDER})`);
}

async function campaignWrite(action: "activate" | "pause"): Promise<void> {
  await sender();
  const result = action === "activate" ? await instantly.activateCampaign(DRILL_CAMPAIGN) : await instantly.pauseCampaign(DRILL_CAMPAIGN);
  console.log(`${action.toUpperCase()} campaign ${s8(DRILL_CAMPAIGN)} → status=${label(CAMPAIGN_STATUS_LABELS, result.status)}`);
  const after = await campaignSchedule();
  console.log(`re-read: status=${after.status}`);
}

function sendDeps(): SendDeps {
  return { db: sendDb, instantly, ledger, queue, transition: state.transition, getActiveSetting, alert };
}

async function send(): Promise<void> {
  const touchId = value("--send");
  const { lead } = await requireDrillLead();
  const account = await sender();
  const touches = await drillTouches(lead.id);
  const t = touches.find((x) => x.id === touchId);
  guard(Boolean(t), "touch is not a drill touch");
  guard(t!.send_account_id === account.id, "touch is not bound to the drill sender");
  guard(normalizeEmail(lead.email ?? "") === DRILL_RECIPIENT, "recipient mismatch");

  const now = new Date();
  const windows = (await getActiveSetting("send_windows")).value as SendWindowsConfig;
  const engine = engineMinutesLeft(windows, lead.timezone ?? "", now);
  const live = await campaignSchedule();
  const campaign = campaignMinutesLeft(live.schedule, now);
  console.log(`gate: engine window (${lead.timezone}) ${engine} min left · campaign schedule ${campaign} min left · campaign status=${live.status}`);
  guard(engine >= MIN_SEND_MINUTES && campaign >= MIN_SEND_MINUTES, `both windows need ≥ ${MIN_SEND_MINUTES} min`);
  const liveAccount = await instantly.getAccount(DRILL_SENDER);
  const budgetOk = await senderBudget(account.id, liveAccount.daily_limit, now, t!.step_no === 1 ? "step1" : "follow-up");
  guard(budgetOk, "sender budget exhausted or unknown for the step-1 enroll");

  const { data: otherJobs } = await (raw as unknown as SupabaseClient<DatabaseWithJobs>)
    .from("jobs")
    .select("id, payload")
    .eq("type", SEND_JOB_TYPE)
    .in("state", ["queued", "leased"]);
  guard((otherJobs ?? []).every((j) => (j.payload as { touch_id?: string }).touch_id === t!.id), "other send jobs are queued — the worker could claim them");

  const enq = await enqueueSend(sendDeps(), { id: t!.id, approval_hash: t!.approval_hash });
  console.log(`enqueued job ${s8(enq.job.id)} deduped=${enq.deduped}`);
  const summary = await runWorker({
    queue,
    registry: createRegistry(sendJobDefinitions(sendDeps())),
    budgetMs: 90_000,
    types: [SEND_JOB_TYPE],
    maxJobs: 1,
  });
  console.log(`worker: claimed=${summary.claimed} completed=${summary.completed} retried=${summary.retried} dead=${summary.dead} stopped=${summary.stoppedReason}`);
  await status();
}

async function reconcile(): Promise<void> {
  await requireDrillLead();
  const summary = await runWorker({
    queue,
    registry: createRegistry(sendJobDefinitions(sendDeps())),
    budgetMs: 90_000,
    types: [RECONCILE_JOB_TYPE],
    maxJobs: 1,
  });
  console.log(`worker (reconcile): claimed=${summary.claimed} completed=${summary.completed} stopped=${summary.stoppedReason}`);
  await status();
}

async function status(): Promise<void> {
  const found = await requireDrillLead();
  const { lead } = found;
  const { data: fresh } = await sendDb.from("leads").select("state, send_account_id, do_not_contact").eq("id", lead.id).single();
  console.log(`\n--- status · lead ${s8(lead.id)} state=${fresh?.state} sender=${s8(fresh?.send_account_id)} dnc=${fresh?.do_not_contact} tz=${lead.timezone}`);
  const touches = await drillTouches(lead.id);
  for (const t of touches) {
    console.log(
      `touch ${s8(t.id)} step=${t.step_no} ${t.direction} status=${t.status} sent_at=${t.sent_at ?? "—"} replied_at=${t.replied_at ?? "—"} ` +
        `provider_message_id=${t.provider_message_id ?? "null"} subject="${t.subject ?? ""}"`,
    );
  }
  const { data: outbox } = await sendDb.from("outbox").select("*").eq("lead_id", lead.id).order("created_at");
  for (const o of outbox ?? []) {
    console.log(
      `outbox ${s8(o.id)} ${o.operation} state=${o.state} provider_lead_id=${o.provider_lead_id ?? "null"} provider_email_id=${o.provider_email_id ?? "null"} ` +
        `thread=${o.provider_thread_id ?? "null"} reply_to=${o.reply_to_email_id ?? "null"} err=${o.last_error ?? "—"}`,
    );
  }
  const { data: day } = await (raw as unknown as SupabaseClient<DatabaseWithCapacity>)
    .from("capacity_ledger")
    .select("*")
    .eq("send_account_id", lead.send_account_id ?? (await sender()).id)
    .eq("date", ledgerDate(new Date()))
    .maybeSingle();
  if (day) console.log(`ledger ${day.date} quota=${day.quota} used=${day.used} reserved=${day.reserved} accepted=${day.accepted} failed=${day.failed}`);
  const touchIds = touches.map((t) => t.id);
  const { data: jobs } = await (raw as unknown as SupabaseClient<DatabaseWithJobs>).from("jobs").select("id, type, state, payload, run_after");
  for (const j of (jobs ?? []).filter((j) => touchIds.includes((j.payload as { touch_id?: string }).touch_id ?? ""))) {
    console.log(`job ${s8(j.id)} ${j.type} state=${j.state} run_after=${j.run_after}`);
  }
  const { data: events } = await baseDb.from("lead_events").select("event, detail, created_at").eq("lead_id", lead.id).order("created_at");
  console.log(`lead_events: ${(events ?? []).map((e) => e.event).join(" → ")}`);
  for (const h of await webhooksFor(DRILL_RECIPIENT, null)) console.log(describeWebhook(h));
  // Attribution check (Session 16): events for the previous drill address since this fixture
  // would mean Instantly tied the alias's mail to the old lead.
  const stray = await webhooksFor(PREVIOUS_DRILL_RECIPIENT, lead.created_at);
  console.log(`webhooks for the previous drill address since this fixture: ${stray.length}`);
  for (const h of stray) console.log(`  ${describeWebhook(h)}`);
}

async function webhooksFor(email: string, since: string | null) {
  let q = webhookDb
    .from("webhook_events")
    .select("id, event_type, processed, processing_error, payload, created_at")
    .eq("provider", "instantly")
    .ilike("payload->>lead_email", email);
  if (since) q = q.gte("created_at", since);
  const { data, error } = await q.order("created_at");
  if (error) throw new Error(`webhook_events: ${error.message}`);
  return data ?? [];
}

function describeWebhook(h: { id: string; event_type: string | null; processed: boolean | null; processing_error: string | null; payload: unknown }): string {
  const p = h.payload as Record<string, unknown>;
  return (
    `webhook ${s8(h.id)} ${h.event_type} processed=${h.processed} source=${p.source ?? "webhook"} lead_email=${p.lead_email ?? "—"} email_id=${p.email_id ?? "null"} ` +
    `step=${p.step ?? "—"} campaign=${s8(p.campaign_id as string | null)} ts=${p.timestamp ?? "—"} is_auto_reply=${p.is_auto_reply ?? "—"} err=${h.processing_error ?? "—"}`
  );
}

/** Read-only: the stored approval hash vs the one preflight recomputes before the send. */
async function verifyHash(): Promise<void> {
  const touchId = value("--verify-hash");
  const { lead } = await requireDrillLead();
  const account = await sender();
  const t = (await drillTouches(lead.id)).find((x) => x.id === touchId);
  guard(Boolean(t), "touch is not a drill touch");
  // Exactly the touch fields send/core.ts buildContext hands preflight (claim_ledger included, 09 §U6b).
  const snapshot = buildApprovalSnapshot(
    {
      id: t!.id,
      step_no: t!.step_no,
      channel: t!.channel,
      subject: t!.subject,
      body: t!.body,
      prompt_version: t!.prompt_version,
      claim_ledger: t!.claim_ledger,
    },
    { id: lead.id, email: lead.email },
    account,
  );
  const recomputed = approvalHash(snapshot);
  console.log(`touch ${s8(t!.id)} step=${t!.step_no} status=${t!.status} claim_ledger=${t!.claim_ledger === null ? "null" : "set"}`);
  console.log(`stored     ${t!.approval_hash ?? "null"}`);
  console.log(`recomputed ${recomputed}`);
  console.log(`match=${t!.approval_hash === recomputed}`);
}

/** Read-only: Instantly's view of the drill enroll (stop_for_company would show as Completed/Skipped). */
async function leadStatus(): Promise<void> {
  const { lead } = await requireDrillLead();
  const { data: outbox } = await sendDb.from("outbox").select("id, operation, provider_lead_id").eq("lead_id", lead.id).not("provider_lead_id", "is", null);
  guard((outbox ?? []).length > 0, "no enroll with a provider_lead_id yet");
  for (const o of outbox ?? []) {
    const r = await instantlyRead(`/api/v2/leads/${encodeURIComponent(o.provider_lead_id!)}`);
    const l = r.json as InstantlyLeadRow | null;
    if (!l?.id) {
      console.log(`outbox ${s8(o.id)} lead ${o.provider_lead_id}: HTTP ${r.status}, no lead body`);
      continue;
    }
    console.log(`outbox ${s8(o.id)} ${o.operation} → HTTP ${r.status} ${describeInstantlyLead(l)}`);
    const ranAStep = Boolean(l.status_summary?.lastStep);
    if ((l.status === 3 || l.status === -3) && !ranAStep) console.log("  BLOCKED: completed/skipped before any step ran — stop and ask");
    else if (l.status_summary?.domain_complete) console.log("  FLAG: domain_complete=true — stop and ask");
    else console.log(`  ok: ${ranAStep ? "a step has run" : "active, no step run yet"}`);
  }
}

/** Read-only: who each drill email was actually addressed to (the Session 16 PASS/STOP evidence). */
async function emails(): Promise<void> {
  const { lead } = await requireDrillLead();
  const { data: outbox } = await sendDb
    .from("outbox")
    .select("id, operation, provider_email_id, created_at")
    .eq("lead_id", lead.id)
    .not("provider_email_id", "is", null)
    .order("created_at");
  guard((outbox ?? []).length > 0, "no drill email with a provider_email_id yet");
  for (const o of outbox ?? []) {
    const r = await instantlyRead(`/api/v2/emails/${encodeURIComponent(o.provider_email_id!)}`);
    const e = (r.json ?? {}) as Record<string, unknown>;
    const to = addressList(e.to_address_email_list as string | null);
    const cc = addressList(e.cc_address_email_list as string | null);
    const bcc = addressList(e.bcc_address_email_list as string | null);
    console.log(`\n${o.operation} · GET /api/v2/emails/${o.provider_email_id} → HTTP ${r.status}`);
    console.log(`  from=${e.from_address_email ?? "—"} eaccount=${e.eaccount ?? "—"} lead=${e.lead ?? "—"}`);
    console.log(`  to="${e.to_address_email_list ?? ""}" cc="${e.cc_address_email_list ?? ""}" bcc="${e.bcc_address_email_list ?? ""}"`);
    console.log(`  thread_id=${e.thread_id ?? "—"} message_id=${e.message_id ?? "—"} ue_type=${e.ue_type ?? "—"} step=${e.step ?? "—"} subject="${e.subject ?? ""}"`);
    console.log(
      `  verdict: lead in To: ${to.includes(DRILL_RECIPIENT) ? "y" : "n"} · ${DRILL_SENDER} in To/Cc: ${to.includes(DRILL_SENDER) || cc.includes(DRILL_SENDER) ? "y" : "n"}` +
        ` · in Bcc: ${bcc.includes(DRILL_SENDER) ? "y" : "n"}`,
    );
  }
}

async function poll(): Promise<void> {
  const { lead } = await requireDrillLead();
  const account = await sender();
  const reconcileDeps: ReconcileDeps = { db: webhookDb, instantly, queue, transition: state.transition, getActiveSetting, alert };
  const count = async () => {
    const { count: inbound } = await sendDb.from("touches").select("id", { count: "exact", head: true }).eq("lead_id", lead.id).eq("direction", "inbound");
    const { count: replies } = await baseDb.from("lead_events").select("id", { count: "exact", head: true }).eq("lead_id", lead.id).eq("event", "reply_received");
    return { inbound: inbound ?? 0, reply_received_events: replies ?? 0 };
  };

  console.log("1) runReplyPoll({sendAccountIds:[drill sender]})");
  const summary = await runReplyPoll(reconcileDeps, { sendAccountIds: [account.id] });
  console.log(`   ${JSON.stringify(summary)}`);

  console.log("2) GET /api/v2/emails vs webhook email_id");
  const { data: hooks } = await webhookDb
    .from("webhook_events")
    .select("event_type, payload")
    .eq("provider", "instantly")
    .ilike("payload->>lead_email", DRILL_RECIPIENT);
  const webhookIds = (type: string) =>
    (hooks ?? []).filter((h) => h.event_type === type && (h.payload as Record<string, unknown>).source !== "reconcile_poll").map((h) => String((h.payload as Record<string, unknown>).email_id ?? "null"));
  const received = await instantly.listEmails({ eaccount: DRILL_SENDER, lead: DRILL_RECIPIENT, emailType: "received", sortOrder: "asc", limit: 10 });
  const sent = await instantly.listEmails({ eaccount: DRILL_SENDER, lead: DRILL_RECIPIENT, emailType: "sent", sortOrder: "asc", limit: 10 });
  for (const e of sent.items) console.log(`   GET sent     id=${e.id} ue_type=${e.ue_type} step=${e.step ?? "—"} thread=${e.thread_id ?? "—"} message_id=${e.message_id} subject="${e.subject}"`);
  for (const e of received.items) console.log(`   GET received id=${e.id} ue_type=${e.ue_type} thread=${e.thread_id ?? "—"} is_auto_reply=${e.is_auto_reply ?? "—"} subject="${e.subject}"`);
  const sentHook = webhookIds("email_sent");
  const replyHook = webhookIds("reply_received");
  console.log(`   webhook email_sent email_id=[${sentHook.join(",")}] · reply_received email_id=[${replyHook.join(",")}]`);
  console.log(`   email_sent id ∈ GET sent: ${sentHook.map((id) => sent.items.some((e) => e.id === id)).join(",") || "n/a"}`);
  console.log(`   reply_received id ∈ GET received: ${replyHook.map((id) => received.items.some((e) => e.id === id)).join(",") || "n/a"}`);

  console.log("3) replay the polled reply through processInstantlyEvent");
  const reply = received.items.find((e) => e.ue_type === 2 || e.ue_type === undefined || e.ue_type === null);
  if (!reply) {
    console.log("   no received email from GET /emails — nothing to replay");
    return;
  }
  const before = await count();
  const { data: freshLead } = await baseDb.from("leads").select("id, email, state, state_changed_at").eq("id", lead.id).single();
  const webhookDeps: InstantlyWebhookDeps = {
    db: webhookDb,
    secret: undefined,
    transition: state.transition,
    instantly,
    queue,
    getActiveSetting,
    alert,
  };
  const outcome = await processInstantlyEvent(webhookDeps, polledReplyPayload(reply, account, freshLead!));
  const after = await count();
  console.log(`   outcome=${JSON.stringify({ ...outcome, eventId: s8((outcome as { eventId?: string }).eventId) })}`);
  console.log(`   before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
}

async function cancelJobs(): Promise<void> {
  const { lead } = await requireDrillLead();
  const touchIds = (await drillTouches(lead.id)).map((t) => t.id);
  const { data: jobs } = await (raw as unknown as SupabaseClient<DatabaseWithJobs>).from("jobs").select("id, type, state, payload").eq("state", "queued");
  const mine = (jobs ?? []).filter((j) => touchIds.includes((j.payload as { touch_id?: string }).touch_id ?? ""));
  for (const j of mine) console.log(`cancel ${s8(j.id)} ${j.type}: ${await queue.cancel(j.id)}`);
  console.log(`queued drill jobs cancelled: ${mine.length}`);
}

async function main(): Promise<void> {
  if (args.includes("--check")) return check();
  if (args.includes("--fixture")) return fixture();
  if (args.includes("--touch")) return touch();
  if (args.includes("--activate")) return campaignWrite("activate");
  if (args.includes("--pause")) return campaignWrite("pause");
  if (args.includes("--send")) return send();
  if (args.includes("--reconcile")) return reconcile();
  if (args.includes("--status")) return status();
  if (args.includes("--verify-hash")) return verifyHash();
  if (args.includes("--lead-status")) return leadStatus();
  if (args.includes("--emails")) return emails();
  if (args.includes("--poll")) return poll();
  if (args.includes("--cancel-jobs")) return cancelJobs();
  console.log("usage: --check | --fixture --tz <IANA> | --touch 1|2 | --activate | --pause | --send <touchId> | --reconcile | --status | --verify-hash <touchId> | --lead-status | --emails | --poll | --cancel-jobs");
}

main().catch((error: unknown) => {
  const kind = error instanceof InstantlyError ? ` (${error.name}${"kind" in error ? `:${String((error as { kind?: string }).kind)}` : ""})` : "";
  console.error(`drill-u6 FAILED${kind}:`, error instanceof Error ? error.message : String(error));
  process.exit(1);
});
