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
  "uncertain",
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
// Dashboard roles (brief §3 "authenticated roles: admin, operator, viewer")
// Ordered least- to most-privileged; ROLE_RANK in lib/auth/core.ts depends on
// this order, so append new roles in rank order, never in the middle.
// ---------------------------------------------------------------------------

export const APP_ROLES = ["viewer", "operator", "admin"] as const;

export type AppRole = (typeof APP_ROLES)[number];
export const appRoleSchema = z.enum(APP_ROLES);

// ---------------------------------------------------------------------------
// State machine transitions (doc 02 §5)
// ---------------------------------------------------------------------------

export const LEAD_STATE_TRANSITIONS: Record<LeadState, LeadState[]> = {
  sourced: ["enriching", "parked", "suppressed", "manual_hold"],
  enriching: ["qualifying", "parked", "suppressed", "manual_hold"],
  qualifying: ["enriching", "parked", "qualified", "suppressed", "manual_hold"],
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
  parked: ["enriching", "suppressed", "manual_hold"],
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

// ---------------------------------------------------------------------------
// Job queue states (09 §U2; check constraint in 0006_jobs.sql)
// ---------------------------------------------------------------------------

export const JOB_STATES = ["queued", "leased", "done", "failed", "dead", "cancelled"] as const;

export type JobState = (typeof JOB_STATES)[number];
export const jobStateSchema = z.enum(JOB_STATES);

// ---------------------------------------------------------------------------
// Capacity reservations (09 §U3; check constraint in 0007_capacity_counters.sql)
// ---------------------------------------------------------------------------

export const CAPACITY_RESERVATION_STATES = [
  "reserved",
  "accepted",
  "failed",
  "released",
  "uncertain",
  "reconciled",
] as const;

export type CapacityReservationState = (typeof CAPACITY_RESERVATION_STATES)[number];
export const capacityReservationStateSchema = z.enum(CAPACITY_RESERVATION_STATES);

/** settle_capacity() outcomes (0007b). */
export const CAPACITY_OUTCOMES = [
  "release",
  "accept",
  "fail",
  "uncertain",
  "reconcile_sent",
  "reconcile_not_sent",
] as const;

export type CapacityOutcome = (typeof CAPACITY_OUTCOMES)[number];
export const capacityOutcomeSchema = z.enum(CAPACITY_OUTCOMES);

// ---------------------------------------------------------------------------
// Send outbox (09 §U5; check constraint in 0008b_outbox.sql)
// ---------------------------------------------------------------------------

export const OUTBOX_STATES = [
  "dispatching",
  "accepted",
  "retry_wait",
  "uncertain",
  "failed",
  "reconciled_sent",
  "reconciled_not_sent",
] as const;

export type OutboxState = (typeof OUTBOX_STATES)[number];
export const outboxStateSchema = z.enum(OUTBOX_STATES);

export const OUTBOX_OPERATIONS = ["enroll", "reply"] as const;
export type OutboxOperation = (typeof OUTBOX_OPERATIONS)[number];

/**
 * Preflight refusal reasons (09 §U5). The first fourteen are the DoD table;
 * the rest are stated extras. Order here is the order preflight reports them.
 */
export const PREFLIGHT_REFUSALS = [
  "blocked_sender_domain",
  "sender_not_allowed",
  "sender_mismatch",
  "lead_state_invalid",
  "channel_unsupported",
  "stale_approval",
  "suppressed_email",
  "suppressed_domain",
  "reply_freeze",
  "booking_hold",
  "manual_hold",
  "email_invalid",
  "email_unverified",
  "sender_unhealthy",
  "duplicate_company_active",
  "thread_anchor_missing",
  "timezone_unknown",
  "outside_window",
  "quota_exhausted",
] as const;

export type PreflightRefusal = (typeof PREFLIGHT_REFUSALS)[number];
