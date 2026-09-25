import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceClient } from "../src/lib/db/service-client";
import {
  accountHealth,
  createInstantlyClient,
  INSTANTLY_BASE_URL,
  InstantlyError,
  InstantlyUncertainOutcomeError,
} from "../src/lib/integrations/instantly";
import { CAMPAIGN_STATUS_LABELS, label } from "../src/lib/integrations/instantly-types";
import { checkSenderDomain } from "../src/lib/sending/guard";
import type { SendPolicy } from "../src/lib/sending/preflight";
import { normalizeEmail } from "../src/lib/sending/suppression";
import { createSettingsStore } from "../src/lib/settings/core";
import { addressList } from "../src/lib/stages/send/core";
import { WEBHOOK_TOKEN_HEADER } from "../src/lib/webhooks/instantly";
import type { Database } from "../src/types/database";
import type { DatabaseWithSending } from "../src/types/database-extensions";

// U6c S18 live spike (09 §U6c "S18", Session 18). Proves, with NO engine code,
// that Instantly-owned follow-up steps (1) go to the lead only, (2) thread under
// step 1, (3) are text-only, (4) stop when the lead is DELETEd.
//
// One operator-owned recipient, one of two allowed mailboxes, one campaign
// named zx-drill-s17-<mailbox>. No engine stages, no DB writes, no Anthropic.
//
//   --check                          read-only: both mailboxes' health, warmup, sent_today vs daily_limit;
//                                    alias leads; drill campaign; webhooks
//   --create                         INSTANTLY WRITE: the drill campaign (paused, 3 fixed steps)
//   --verify                         read-only: the campaign as stored (sequences verbatim)
//   --webhook-create --url <https>   INSTANTLY WRITE: one all_events webhook scoped to the drill campaign
//   --listen --port N --log <jsonl>  local sink: 401 without the token, else append the payload
//   --enroll                         INSTANTLY WRITE: leads/add of the alias only
//   --activate | --pause             INSTANTLY WRITE: the drill campaign only
//   --lead-status                    read-only: the alias's Instantly lead
//   --emails                         read-only: GET /emails for the alias + recipient/thread verdicts
//   --watch --until-step N [--then-delete] [--timeout-min M] [--log <jsonl>]
//                                    read-only poll; --then-delete (step 2 only, operator pre-approved)
//                                    runs the --delete-lead path the moment step 2 is seen
//   --delete-lead                    INSTANTLY WRITE: DELETE the alias lead, confirm GET 404 / list 0
//   --status                         read-only summary
//
// Every command takes --sender <amir@zyndixhq.com|amir@getzyndix.com> except --listen.
// Secrets are never printed.

const RECIPIENT = "ebadiamirhoseineng+s17@gmail.com";
const TAG = "drill:s17";
const ALLOWED_SENDERS = ["amir@zyndixhq.com", "amir@getzyndix.com"] as const;
const SUBJECT = "Zyndix spike S17";
const BODIES = [
  "Hi Amir,\n\nZyndix U6c spike (Session 18, step 1): a fixed test message to an operator-owned mailbox. No action needed.",
  "Hi Amir,\n\nZyndix U6c spike (Session 18, step 2): an Instantly-owned follow-up step. It should thread under step 1, addressed to you only.",
  "Hi Amir,\n\nZyndix U6c spike (Session 18, step 3): this step should NEVER arrive — the lead is deleted after step 2.",
];
const STEP_DELAY_MINUTES = 5;
const POLL_MS = 30_000;
const OWN_DOMAINS = ["zyndix.com", "zyndixhq.com", "getzyndix.com"];

const args = process.argv.slice(2);
const value = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const s8 = (id: string | null | undefined): string => (id ? id.slice(0, 8) : "—");
const now = () => new Date().toISOString();

class SpikeGuardError extends Error {}
function guard(ok: boolean, why: string): asserts ok {
  if (!ok) throw new SpikeGuardError(`GUARD: ${why} — nothing written`);
}

const instantly = createInstantlyClient();

// ---------------------------------------------------------------------------
// Sender and campaign identity
// ---------------------------------------------------------------------------

function senderArg(): string {
  const s = normalizeEmail(value("--sender") ?? "");
  guard((ALLOWED_SENDERS as readonly string[]).includes(s), `--sender must be one of ${ALLOWED_SENDERS.join(", ")}`);
  guard(checkSenderDomain(s).ok, `sender domain check failed for ${s}`);
  return s;
}

/** zx-drill-s17-amir-zyndixhq for amir@zyndixhq.com. */
function drillCampaignName(sender: string): string {
  const [local, domain] = sender.split("@");
  return `zx-drill-s17-${local}-${domain!.split(".")[0]}`;
}

async function findDrillCampaigns(sender: string) {
  const name = drillCampaignName(sender);
  const all = (await instantly.listAllCampaigns()).items;
  return all.filter((c) => c.name === name);
}

/** The drill campaign, resolved by name: exactly one, whose email_list is exactly [sender]. */
async function drillCampaign(sender: string) {
  const matches = await findDrillCampaigns(sender);
  guard(matches.length === 1, `expected exactly 1 campaign named ${drillCampaignName(sender)}, found ${matches.length}`);
  const c = await instantly.getCampaign(matches[0]!.id);
  const list = (c.email_list ?? []).map((e) => normalizeEmail(e));
  guard(list.length === 1 && list[0] === sender, `campaign email_list=${JSON.stringify(c.email_list)} is not exactly [${sender}]`);
  return c;
}

// ---------------------------------------------------------------------------
// Raw Instantly access (reads, plus exactly one allowlisted write)
// ---------------------------------------------------------------------------

const READ_ONLY_POSTS = new Set(["/api/v2/leads/list", "/api/v2/accounts/warmup-analytics"]);
const RAW_WRITES = new Set(["POST /api/v2/campaigns"]);

async function instantlyRaw(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const bare = path.split("?")[0]!;
  guard(method === "GET" || READ_ONLY_POSTS.has(bare) || RAW_WRITES.has(`${method} ${bare}`), `raw helper refuses ${method} ${bare}`);
  const key = process.env.INSTANTLY_API_KEY;
  guard(Boolean(key), "INSTANTLY_API_KEY missing");
  const res = await fetch(new URL(path, INSTANTLY_BASE_URL), {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = (await res.text()).split(key!).join("[redacted]");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

type LeadRow = {
  id: string;
  email?: string;
  campaign?: string | null;
  status?: number;
  status_summary?: { domain_complete?: boolean; lastStep?: { from?: string; stepID?: string; timestamp_executed?: string } };
};
const LEAD_STATUS: Record<string, string> = { "1": "Active", "2": "Paused", "3": "Completed", "-1": "Bounced", "-2": "Unsubscribed", "-3": "Skipped" };

function describeLead(l: LeadRow): string {
  const last = l.status_summary?.lastStep;
  return (
    `${l.id} campaign=${s8(l.campaign ?? null)} status=${l.status ?? "?"}(${LEAD_STATUS[String(l.status)] ?? "?"}) ` +
    `domain_complete=${l.status_summary?.domain_complete ?? "—"} lastStep=${last ? `${last.from ?? "?"}@${last.timestamp_executed ?? "?"}` : "none"}`
  );
}

async function aliasLeads(campaignId?: string): Promise<{ status: number; matches: LeadRow[] }> {
  const r = await instantlyRaw("POST", "/api/v2/leads/list", { contacts: [RECIPIENT], limit: 10, ...(campaignId ? { campaign: campaignId } : {}) });
  const items = ((r.json as { items?: LeadRow[] } | null)?.items ?? []).filter((l) => normalizeEmail(l.email ?? "") === RECIPIENT);
  return { status: r.status, matches: items };
}

type EmailRow = Record<string, unknown> & { id: string };

async function aliasEmails(campaignId: string): Promise<{ status: number; items: EmailRow[] }> {
  const q = new URLSearchParams({ lead: RECIPIENT, campaign_id: campaignId, limit: "20", sort_order: "asc" });
  const r = await instantlyRaw("GET", `/api/v2/emails?${q.toString()}`);
  const items = ((r.json as { items?: EmailRow[] } | null)?.items ?? []).filter((e) => typeof e.id === "string");
  return { status: r.status, items };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function check(): Promise<void> {
  const at = new Date();
  const day = at.toISOString().slice(0, 10);
  console.log(`=== spike-u6c --check (read-only) · ${at.toISOString()} · recipient ${RECIPIENT} · tag ${TAG} ===`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  guard(Boolean(url && key), "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const raw = createServiceClient(url!, key!);
  const policy = (await createSettingsStore(raw as SupabaseClient<Database>).getActiveSetting("send_policy" as never)).value as SendPolicy;
  const { data: accounts } = await (raw as unknown as SupabaseClient<DatabaseWithSending>)
    .from("send_accounts")
    .select("identifier, health, instantly_campaign_id");
  const campaigns = (await instantly.listAllCampaigns()).items;
  const warmup = await instantly.getWarmupAnalytics([...ALLOWED_SENDERS]);

  const room: Array<{ sender: string; left: number | null; healthy: boolean }> = [];
  for (const sender of ALLOWED_SENDERS) {
    const acct = await instantly.getAccount(sender);
    const h = accountHealth(acct, warmup.aggregate_data[sender] ?? null, { minWarmupScore: policy.min_warmup_score });
    const q = new URLSearchParams({ start_date: day, end_date: day });
    q.append("emails", sender);
    const a = await instantlyRaw("GET", `/api/v2/accounts/analytics/daily?${q.toString()}`);
    const rows = Array.isArray(a.json) ? (a.json as Array<{ date?: string; email_account?: string; sent?: number }>) : null;
    const mine = rows?.filter((x) => normalizeEmail(x.email_account ?? "") === sender && (x.date ?? "").slice(0, 10) === day) ?? [];
    const sentToday = rows === null ? null : mine.reduce((s, x) => s + (x.sent ?? 0), 0);
    const limit = acct.daily_limit ?? null;
    const left = sentToday === null || limit === null ? null : limit - sentToday;
    const engine = (accounts ?? []).find((x) => normalizeEmail(x.identifier ?? "") === sender);
    const prod = campaigns.find((c) => c.id === engine?.instantly_campaign_id);
    console.log(`\n${sender}`);
    console.log(`  instantly health=${h.verdict} warmup_score=${h.warmupScore ?? "null"} (min ${policy.min_warmup_score})${h.reasons.length ? ` reasons=[${h.reasons.join("; ")}]` : ""}`);
    console.log(`  engine health=${engine?.health ?? "no row"} · prod campaign ${s8(engine?.instantly_campaign_id)} "${prod?.name ?? "?"}" status=${prod ? label(CAMPAIGN_STATUS_LABELS, prod.status) : "?"}`);
    console.log(`  ${day} (UTC date queried): sent_today=${sentToday ?? "null"}${rows !== null && mine.length === 0 ? " (no row)" : ""} · daily_limit=${limit ?? "null"} · analytics HTTP ${a.status}`);
    console.log(`  → spike needs 3 sends: set daily_limit ≥ ${sentToday === null ? "UNKNOWN" : sentToday + 3} in the UI (room now: ${left ?? "unknown"})`);
    const drill = campaigns.filter((c) => c.name === drillCampaignName(sender));
    console.log(`  drill campaign "${drillCampaignName(sender)}": ${drill.length ? drill.map((c) => `${c.id} status=${label(CAMPAIGN_STATUS_LABELS, c.status)}`).join(", ") : "none (ok)"}`);
    room.push({ sender, left, healthy: h.verdict === "healthy" });
  }

  const leads = await aliasLeads();
  console.log(`\nworkspace leads for ${RECIPIENT}: HTTP ${leads.status} · ${leads.matches.length} match(es)${leads.matches.length ? "" : " (ok)"}`);
  for (const l of leads.matches) console.log(`  ${describeLead(l)}`);
  const hooks = await instantly.listWebhooks({ limit: 100 });
  console.log(`webhooks: ${hooks.items.length}`);
  for (const w of hooks.items) console.log(`  ${w.id} ${w.event_type ?? "custom"} → ${w.target_hook_url}`);

  const best = [...room].filter((r) => r.healthy).sort((a, b) => (b.left ?? -99) - (a.left ?? -99))[0];
  console.log(`\nRECOMMEND: ${best ? `${best.sender} (room ${best.left ?? "unknown"})` : "none healthy — stop"}`);
}

function campaignPayload(sender: string, followUpSubject: string) {
  const step = (subject: string, body: string) => ({
    type: "email" as const,
    delay: STEP_DELAY_MINUTES,
    delay_unit: "minutes" as const,
    variants: [{ subject, body }],
  });
  return {
    name: drillCampaignName(sender),
    campaign_schedule: {
      schedules: [
        {
          name: "spike 24/7",
          timing: { from: "00:00", to: "23:59" },
          days: { "0": true, "1": true, "2": true, "3": true, "4": true, "5": true, "6": true },
          timezone: "Europe/Helsinki",
        },
      ],
    },
    // delay on every step: the spec says delay is "before sending the NEXT email";
    // 5 min everywhere gives ~5 min between steps under either reading, never 0.
    sequences: [{ steps: [step(SUBJECT, BODIES[0]!), step(followUpSubject, BODIES[1]!), step(followUpSubject, BODIES[2]!)] }],
    email_list: [sender],
    daily_limit: 3,
    daily_max_leads: 1,
    email_gap: 10,
    random_wait_max: 5,
    open_tracking: false,
    link_tracking: false,
    text_only: true,
    first_email_text_only: true,
    stop_on_reply: true,
    stop_on_auto_reply: false,
    stop_for_company: true,
    insert_unsubscribe_header: true,
  };
}

async function create(): Promise<void> {
  const sender = senderArg();
  guard((await findDrillCampaigns(sender)).length === 0, `a campaign named ${drillCampaignName(sender)} already exists`);
  console.log(`CREATE ${drillCampaignName(sender)} · sender ${sender} · follow-up subject "" · ${now()}`);
  let r = await instantlyRaw("POST", "/api/v2/campaigns", campaignPayload(sender, ""));
  console.log(`  POST /api/v2/campaigns (empty follow-up subject) → HTTP ${r.status}`);
  if (r.status >= 500 || r.status === 0) {
    console.log(`  UNCERTAIN: ${r.text.slice(0, 1000)} — do not retry; re-list campaigns by name`);
    process.exit(1);
  }
  if (r.status >= 400) {
    console.log(`  EMPTY_SUBJECT_REJECTED? exact error body:\n  ${r.text.slice(0, 2000)}`);
    guard((await findDrillCampaigns(sender)).length === 0, "campaign exists after a 4xx — not retrying");
    console.log(`  retry once with follow-up subject = "${SUBJECT}"`);
    r = await instantlyRaw("POST", "/api/v2/campaigns", campaignPayload(sender, SUBJECT));
    console.log(`  POST /api/v2/campaigns (follow-up subject = step 1) → HTTP ${r.status}`);
    if (r.status >= 400) {
      console.log(`  FAILED after retry: ${r.text.slice(0, 2000)} — STOP`);
      process.exit(1);
    }
    console.log("  NOTE: EMPTY_SUBJECT_REJECTED — follow-ups use the step-1 subject");
  } else {
    console.log("  empty follow-up subject ACCEPTED by the API");
  }
  const created = r.json as { id?: string; status?: number } | null;
  console.log(`  CREATED ${created?.id ?? "?"} status=${label(CAMPAIGN_STATUS_LABELS, created?.status)}`);
  if (created?.status === 1) console.log("  WARN: ACTIVE on create — pause before enrolling");
  await verify();
}

async function verify(): Promise<void> {
  const sender = senderArg();
  const c = await drillCampaign(sender);
  const r = await instantlyRaw("GET", `/api/v2/campaigns/${encodeURIComponent(c.id)}`);
  const j = (r.json ?? {}) as Record<string, unknown>;
  console.log(`\n--verify ${c.id} "${j.name}" → HTTP ${r.status} status=${label(CAMPAIGN_STATUS_LABELS, j.status as number)}`);
  console.log(`  email_list=${JSON.stringify(j.email_list)} daily_limit=${j.daily_limit} daily_max_leads=${j.daily_max_leads} email_gap=${j.email_gap} random_wait_max=${j.random_wait_max}`);
  console.log(
    `  text_only=${j.text_only} first_email_text_only=${j.first_email_text_only} open_tracking=${j.open_tracking} link_tracking=${j.link_tracking ?? "not echoed"} ` +
      `stop_on_reply=${j.stop_on_reply} stop_for_company=${j.stop_for_company} insert_unsubscribe_header=${j.insert_unsubscribe_header}`,
  );
  console.log(`  campaign_schedule=${JSON.stringify(j.campaign_schedule)}`);
  console.log(`  sequences (as stored):\n${JSON.stringify(j.sequences, null, 2)}`);
}

async function webhookCreate(): Promise<void> {
  const sender = senderArg();
  const target = value("--url");
  guard(Boolean(target && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/hook$/.test(target)), "--url must be https://<quick-tunnel>.trycloudflare.com/hook");
  const secret = process.env.INSTANTLY_WEBHOOK_SECRET;
  guard(Boolean(secret && secret.length >= 32), "INSTANTLY_WEBHOOK_SECRET missing or < 32 chars");
  const c = await drillCampaign(sender);
  const existing = await instantly.listWebhooks({ limit: 100 });
  guard(!existing.items.some((w) => w.target_hook_url === target), "a webhook for this URL already exists");
  const hook = await instantly.createWebhook({
    targetUrl: target!,
    eventType: "all_events",
    name: "zyndix-spike-s17",
    campaignId: c.id,
    authHeader: { name: WEBHOOK_TOKEN_HEADER, value: secret! },
  });
  console.log(`CREATED webhook ${hook.id} event_type=${hook.event_type} campaign=${s8(c.id)} headers=[${hook.header_names.join(",")}] · ${now()}`);
}

function listen(): void {
  const port = Number(value("--port"));
  const log = value("--log");
  const secret = process.env.INSTANTLY_WEBHOOK_SECRET ?? "";
  guard(Number.isInteger(port) && port > 1024 && Boolean(log) && secret.length >= 32, "--listen needs --port N --log <jsonl> and the webhook secret");
  const tokenOk = (got: string | undefined): boolean => {
    const a = Buffer.from(got ?? "");
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/hook") {
      res.writeHead(404).end();
      return;
    }
    const header = req.headers[WEBHOOK_TOKEN_HEADER];
    if (!tokenOk(Array.isArray(header) ? header[0] : header)) {
      console.log(`${now()} 401 (no/bad token)`);
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      let p: Record<string, unknown> = {};
      try {
        p = JSON.parse(body) as Record<string, unknown>;
      } catch {
        p = { unparsable: body.slice(0, 500) };
      }
      appendFileSync(log!, `${JSON.stringify({ received_at: now(), payload: p })}\n`);
      console.log(
        `${now()} 200 event_type=${p.event_type ?? "?"} step=${p.step ?? "—"} variant=${p.variant ?? "—"} email_id=${p.email_id ?? "—"} ` +
          `lead_email=${p.lead_email ?? "—"} email_account=${p.email_account ?? "—"} campaign=${s8(p.campaign_id as string | undefined)} ts=${p.timestamp ?? "—"}`,
      );
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  }).listen(port, "127.0.0.1", () => console.log(`spike listener on 127.0.0.1:${port}/hook → ${log}`));
}

async function enroll(): Promise<void> {
  const sender = senderArg();
  const c = await drillCampaign(sender);
  const existing = await aliasLeads();
  guard(existing.matches.length === 0, `workspace already has ${existing.matches.length} lead(s) for ${RECIPIENT}`);
  const result = await instantly.enrollLead({
    campaignId: c.id,
    lead: { email: RECIPIENT, first_name: "Amir", last_name: "Spike S17", company_name: "ZX DRILL S17" },
    dedupe: "workspace",
  });
  console.log(`ENROLL ${RECIPIENT} → campaign ${s8(c.id)}: ${result.outcome}${result.outcome === "created" ? ` lead=${result.leadId}` : ` reason=${result.reason}`} · ${now()}`);
  await leadStatus();
}

async function campaignWrite(action: "activate" | "pause"): Promise<void> {
  const sender = senderArg();
  const c = await drillCampaign(sender);
  const result = action === "activate" ? await instantly.activateCampaign(c.id) : await instantly.pauseCampaign(c.id);
  console.log(`${action.toUpperCase()} ${c.id} → status=${label(CAMPAIGN_STATUS_LABELS, result.status)} · ${now()}`);
  const after = await instantly.getCampaign(c.id);
  console.log(`re-read: status=${label(CAMPAIGN_STATUS_LABELS, after.status)}`);
}

async function leadStatus(): Promise<void> {
  const sender = senderArg();
  const c = await drillCampaign(sender);
  const list = await aliasLeads(c.id);
  console.log(`leads/list (campaign ${s8(c.id)}) for ${RECIPIENT}: HTTP ${list.status} · ${list.matches.length}`);
  for (const l of list.matches) {
    const r = await instantlyRaw("GET", `/api/v2/leads/${encodeURIComponent(l.id)}`);
    const full = (r.json as LeadRow | null) ?? l;
    console.log(`  GET /leads/${l.id} → HTTP ${r.status} ${describeLead(full.id ? full : l)}`);
    const ran = Boolean(full.status_summary?.lastStep);
    if ((full.status === 3 || full.status === -3) && !ran) console.log("  BLOCKED: completed/skipped before any step ran — stop");
    else if (full.status_summary?.domain_complete) console.log("  FLAG: domain_complete=true — stop and ask");
  }
}

function isOwn(address: string, ownMailboxes: string[]): boolean {
  const a = normalizeEmail(address);
  const domain = a.split("@")[1] ?? "";
  return ownMailboxes.includes(a) || OWN_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

async function emails(): Promise<EmailRow[]> {
  const sender = senderArg();
  const c = await drillCampaign(sender);
  const r = await aliasEmails(c.id);
  console.log(`GET /api/v2/emails?lead=${RECIPIENT}&campaign_id=${s8(c.id)} → HTTP ${r.status} · ${r.items.length} email(s) · ${now()}`);
  const own = [...ALLOWED_SENDERS] as string[];
  const firstThread = r.items.find((e) => e.ue_type !== 2)?.thread_id ?? null;
  for (const e of r.items) {
    const to = addressList(e.to_address_email_list as string | null);
    const cc = addressList(e.cc_address_email_list as string | null);
    const bcc = addressList(e.bcc_address_email_list as string | null);
    const body = (e.body ?? {}) as { text?: string | null; html?: string | null };
    console.log(`\n  id=${e.id} step=${e.step ?? "—"} ue_type=${e.ue_type ?? "—"} ts=${e.timestamp_email ?? e.timestamp_created ?? "—"}`);
    console.log(`  from=${e.from_address_email ?? "—"} eaccount=${e.eaccount ?? "—"}`);
    console.log(`  to="${e.to_address_email_list ?? ""}" cc="${e.cc_address_email_list ?? ""}" bcc="${e.bcc_address_email_list ?? ""}"`);
    console.log(`  thread_id=${e.thread_id ?? "—"} message_id=${e.message_id ?? "—"} subject="${e.subject ?? ""}"`);
    console.log(`  body: text=${body.text ? `${body.text.length} chars` : "none"} html=${body.html ? `${body.html.length} chars${/<[a-z][^>]*>/i.test(body.html) ? " (has tags)" : ""}` : "none"}`);
    if (e.ue_type === 2) continue; // a received email: no recipient verdict
    const toOnlyAlias = to.length === 1 && to[0] === RECIPIENT;
    const ownHit = [...to, ...cc, ...bcc].filter((x) => isOwn(x, own));
    console.log(
      `  verdict: To==[alias] only: ${toOnlyAlias ? "PASS" : "FAIL"} · Cc/Bcc empty: ${cc.length + bcc.length === 0 ? "PASS" : "FAIL"} · ` +
        `own address: ${ownHit.length ? `FAIL ${ownHit.join(",")}` : "none (PASS)"} · same thread as first: ${e.thread_id === firstThread ? "PASS" : "FAIL"}`,
    );
  }
  return r.items;
}

function stepsInLog(log: string | null): Map<string, string> {
  const seen = new Map<string, string>();
  if (!log || !existsSync(log)) return seen;
  for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
    try {
      const { received_at, payload } = JSON.parse(line) as { received_at: string; payload: Record<string, unknown> };
      if (payload.event_type === "email_sent" && normalizeEmail(String(payload.lead_email ?? "")) === RECIPIENT && payload.step !== undefined) {
        const k = String(payload.step);
        if (!seen.has(k)) seen.set(k, `${received_at} email_id=${payload.email_id ?? "—"} variant=${payload.variant ?? "—"}`);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return seen;
}

async function watch(): Promise<void> {
  const sender = senderArg();
  const until = Number(value("--until-step"));
  const thenDelete = args.includes("--then-delete");
  const timeoutMin = Number(value("--timeout-min") ?? "45");
  const log = value("--log");
  guard(until >= 1 && until <= 3, "--until-step 1|2|3");
  guard(!thenDelete || until === 2, "--then-delete only with --until-step 2");
  const c = await drillCampaign(sender);
  const deadline = Date.now() + timeoutMin * 60_000;
  console.log(`WATCH campaign ${s8(c.id)} for step ${until}${thenDelete ? " then DELETE" : ""} · timeout ${timeoutMin} min · log ${log ?? "none"} · ${now()}`);
  const reported = new Set<string>();
  for (;;) {
    const r = await aliasEmails(c.id).catch((e: unknown) => ({ status: -1, items: [] as EmailRow[], err: String(e) }));
    for (const e of r.items) {
      if (reported.has(e.id)) continue;
      reported.add(e.id);
      console.log(`${now()} API email id=${e.id} step=${e.step ?? "—"} ue_type=${e.ue_type ?? "—"} to="${e.to_address_email_list ?? ""}" ts=${e.timestamp_email ?? e.timestamp_created ?? "—"}`);
    }
    const hooks = stepsInLog(log);
    for (const [k, v] of hooks) {
      if (reported.has(`hook:${k}`)) continue;
      reported.add(`hook:${k}`);
      console.log(`${now()} WEBHOOK email_sent step=${k} ${v}`);
    }
    // The GET /emails `step` format is undocumented (09 §U6c e), so the API side
    // counts sent emails; the webhook side uses its documented 1-indexed `step`.
    const apiSent = r.items.filter((e) => e.ue_type !== 2).length;
    const hit = hooks.has(String(until)) || apiSent >= until;
    if (hit) {
      console.log(`STEP ${until} SEEN at ${now()} (api sent count=${apiSent}, webhook steps=[${[...hooks.keys()].join(",")}])`);
      if (thenDelete) await deleteLead();
      return;
    }
    if (Date.now() > deadline) {
      console.log(`TIMEOUT: step ${until} not seen after ${timeoutMin} min (api sent count=${apiSent}, webhook steps=[${[...hooks.keys()].join(",")}]) · ${now()}`);
      process.exit(2);
    }
    await new Promise((r2) => setTimeout(r2, POLL_MS));
  }
}

async function deleteLead(): Promise<void> {
  const sender = senderArg();
  const c = await drillCampaign(sender);
  const list = await aliasLeads(c.id);
  guard(list.matches.length === 1, `expected exactly 1 alias lead in the drill campaign, found ${list.matches.length}`);
  const lead = list.matches[0]!;
  guard(normalizeEmail(lead.email ?? "") === RECIPIENT, "lead email is not the alias");
  guard(!lead.campaign || lead.campaign === c.id, "lead is not in the drill campaign");
  console.log(`DELETE /api/v2/leads/${lead.id} · ${now()}`);
  try {
    await instantly.deleteLead(lead.id);
    console.log(`  accepted · ${now()}`);
  } catch (error) {
    if (!(error instanceof InstantlyUncertainOutcomeError)) throw error;
    console.log(`  UNCERTAIN: ${error.message} — confirming with GET, not retrying`);
  }
  const g = await instantlyRaw("GET", `/api/v2/leads/${encodeURIComponent(lead.id)}`);
  const after = await aliasLeads(c.id);
  console.log(`  confirm: GET /leads/${lead.id} → HTTP ${g.status} · leads/list → ${after.matches.length} · ${now()}`);
  console.log(`  ${g.status === 404 || after.matches.length === 0 ? "DELETE CONFIRMED" : "DELETE NOT CONFIRMED — stop and ask"}`);
}

async function status(): Promise<void> {
  const sender = senderArg();
  const c = await drillCampaign(sender);
  console.log(`campaign ${c.id} "${c.name}" status=${label(CAMPAIGN_STATUS_LABELS, c.status)}`);
  await leadStatus();
  const r = await aliasEmails(c.id);
  console.log(`emails: ${r.items.length} (${r.items.map((e) => `step=${e.step ?? "—"}/ue=${e.ue_type ?? "—"}`).join(", ")})`);
  const hooks = stepsInLog(value("--log"));
  console.log(`listener email_sent steps: [${[...hooks.entries()].map(([k, v]) => `${k}: ${v}`).join(" | ")}]`);
}

async function main(): Promise<void> {
  if (args.includes("--listen")) return listen();
  if (args.includes("--check")) return check();
  if (args.includes("--create")) return create();
  if (args.includes("--verify")) return verify();
  if (args.includes("--webhook-create")) return webhookCreate();
  if (args.includes("--enroll")) return enroll();
  if (args.includes("--activate")) return campaignWrite("activate");
  if (args.includes("--pause")) return campaignWrite("pause");
  if (args.includes("--lead-status")) return leadStatus();
  if (args.includes("--emails")) return void (await emails());
  if (args.includes("--watch")) return watch();
  if (args.includes("--delete-lead")) return deleteLead();
  if (args.includes("--status")) return status();
  console.log(
    "usage: --sender <mailbox> with --check | --create | --verify | --webhook-create --url <…/hook> | --enroll | --activate | --pause | " +
      "--lead-status | --emails | --watch --until-step N [--then-delete] [--timeout-min M] [--log f] | --delete-lead | --status\n" +
      "       --listen --port N --log <jsonl>",
  );
}

main().catch((error: unknown) => {
  const kind = error instanceof InstantlyError ? ` (${error.name})` : "";
  console.error(`spike-u6c FAILED${kind}:`, error instanceof Error ? error.message : String(error));
  process.exit(1);
});
