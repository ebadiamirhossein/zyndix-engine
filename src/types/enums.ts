import { z } from "zod";

// ---------------------------------------------------------------------------
// Lead pipeline states (doc 02 §5)
// ---------------------------------------------------------------------------

export const LEAD_STATES = [
  "sourced",
  "enriching",
  "qualifying",
  "parked",
  "qualified",
  "verifying",
  "drafting",
  "pending_approval",
  "approved",
  "queued",
  "sent",
  "replied",
  "classifying",
  "human_review",
  "bounced",
  "no_reply",
  "sequence_done",
  "meeting_booked",
  "handed_off",
  "suppressed",
  "manual_hold",
] as const;

export type LeadState = (typeof LEAD_STATES)[number];
export const leadStateSchema = z.enum(LEAD_STATES);

// ---------------------------------------------------------------------------
// Touch fields (doc 02 §3.2)
// ---------------------------------------------------------------------------

export const TOUCH_STATUSES = [
  "drafted",
  "pending_approval",
  "approved",
  "edited",
  "killed",
  "queued",
  "sent",
  "delivered",
  "bounced",
  "opened",
  "replied",
  "failed",
] as const;

export type TouchStatus = (typeof TOUCH_STATUSES)[number];
export const touchStatusSchema = z.enum(TOUCH_STATUSES);

export const TOUCH_DIRECTIONS = ["outbound", "inbound"] as const;
export type TouchDirection = (typeof TOUCH_DIRECTIONS)[number];
export const touchDirectionSchema = z.enum(TOUCH_DIRECTIONS);

export const TOUCH_CHANNELS = [
  "email",
  "linkedin_connect",
  "linkedin_msg",
] as const;

export type TouchChannel = (typeof TOUCH_CHANNELS)[number];
export const touchChannelSchema = z.enum(TOUCH_CHANNELS);

// ---------------------------------------------------------------------------
// Email verification (doc 02 §2.2)
// ---------------------------------------------------------------------------

export const EMAIL_STATUSES = [
  "unverified",
  "valid",
  "catch_all",
  "invalid",
] as const;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];
export const emailStatusSchema = z.enum(EMAIL_STATUSES);

// ---------------------------------------------------------------------------
// Company status (doc 02 §2.1)
// ---------------------------------------------------------------------------

export const COMPANY_STATUSES = [
  "new",
  "enriching",
  "qualified",
  "parked",
  "disqualified",
  "active_outreach",
  "replied",
  "meeting",
  "client",
  "lost",
] as const;

export type CompanyStatus = (typeof COMPANY_STATUSES)[number];
export const companyStatusSchema = z.enum(COMPANY_STATUSES);

// ---------------------------------------------------------------------------
// Send account (doc 02 §3.3)
// ---------------------------------------------------------------------------

export const SEND_ACCOUNT_HEALTH = ["ok", "degraded", "paused"] as const;
export type SendAccountHealth = (typeof SEND_ACCOUNT_HEALTH)[number];
export const sendAccountHealthSchema = z.enum(SEND_ACCOUNT_HEALTH);

export const SEND_ACCOUNT_RAMP_STAGES = [
  "warmup",
  "ramp1",
  "ramp2",
  "full",
] as const;

export type SendAccountRampStage = (typeof SEND_ACCOUNT_RAMP_STAGES)[number];
export const sendAccountRampStageSchema = z.enum(SEND_ACCOUNT_RAMP_STAGES);

// ---------------------------------------------------------------------------
// Reply classification (doc 02 §3.2 touches + doc 04 classifier unsubscribe)
// ---------------------------------------------------------------------------

export const REPLY_CLASSIFICATIONS = [
  "interested",
  "question",
  "objection",
  "not_now",
  "negative",
  "ooo",
  "wrong_person",
  "unsubscribe",
] as const;

export type ReplyClassification = (typeof REPLY_CLASSIFICATIONS)[number];
export const replyClassificationSchema = z.enum(REPLY_CLASSIFICATIONS);

// ---------------------------------------------------------------------------
// State machine transitions (doc 02 §5)
// ---------------------------------------------------------------------------

export const LEAD_STATE_TRANSITIONS: Record<LeadState, LeadState[]> = {
  sourced: ["enriching", "suppressed", "manual_hold"],
  enriching: ["qualifying", "parked", "suppressed", "manual_hold"],
  qualifying: ["parked", "qualified", "suppressed", "manual_hold"],
  qualified: ["verifying", "parked", "suppressed", "manual_hold"],
  verifying: ["parked", "drafting", "suppressed", "manual_hold"],
  drafting: ["pending_approval", "parked", "suppressed", "manual_hold"],
  pending_approval: ["approved", "parked", "suppressed", "manual_hold"],
  approved: ["queued", "suppressed", "manual_hold"],
  queued: ["sent", "suppressed", "manual_hold"],
  sent: ["replied", "bounced", "no_reply", "suppressed", "manual_hold"],
  replied: ["classifying", "suppressed", "manual_hold"],
  classifying: [
    "human_review",
    "sent",
    "meeting_booked",
    "parked",
    "suppressed",
    "manual_hold",
  ],
  human_review: [
    "meeting_booked",
    "sent",
    "parked",
    "suppressed",
    "manual_hold",
  ],
  bounced: ["parked", "suppressed", "manual_hold"],
  no_reply: ["drafting", "sequence_done", "suppressed", "manual_hold"],
  sequence_done: ["suppressed", "manual_hold"],
  meeting_booked: ["handed_off", "suppressed", "manual_hold"],
  handed_off: ["suppressed", "manual_hold"],
  parked: ["suppressed", "manual_hold"],
  suppressed: [],
  manual_hold: [
    "sourced",
    "enriching",
    "qualifying",
    "qualified",
    "verifying",
    "drafting",
    "pending_approval",
    "approved",
    "queued",
    "sent",
    "replied",
    "classifying",
    "human_review",
    "parked",
    "no_reply",
    "sequence_done",
    "meeting_booked",
    "handed_off",
    "suppressed",
  ],
};

const GLOBAL_TRANSITIONS: LeadState[] = ["suppressed", "manual_hold"];

export function canTransition(from: LeadState, to: LeadState): boolean {
  if (from === "suppressed") {
    return false;
  }
  if (GLOBAL_TRANSITIONS.includes(to)) {
    return true;
  }
  return LEAD_STATE_TRANSITIONS[from].includes(to);
}
