import type { z } from "zod";

import type { capacityDefaultsSchema, sendWindowsSchema } from "@/lib/validation/jsonb";

// ---------------------------------------------------------------------------
// Send windows and the warmup ramp (09 §U3). Pure: no DB, no clock reads —
// `now` and the RNG are always passed in, so every case is table-testable.
//
// Windows are evaluated in the RECIPIENT's IANA timezone (CLAUDE.md). All
// returned instants are UTC Date objects.
// ---------------------------------------------------------------------------

export type SendWindowsConfig = z.infer<typeof sendWindowsSchema>;
export type EmailInboxRamp = z.infer<typeof capacityDefaultsSchema>["email_inbox"];

export type WindowTier = "priority" | "secondary";

export type SendWindow = {
  /** Earliest allowed instant: the window's opening, or `now` if it is already open. */
  start: Date;
  /** When the window opens, even if that is before `now`. */
  opensAt: Date;
  /** Exclusive. */
  end: Date;
  tier: WindowTier;
  /** Recipient-local calendar date, YYYY-MM-DD. */
  localDate: string;
  timeZone: string;
};

/**
 * Operator decision 2026-09-24: prefer the next priority window if it opens
 * within this many hours of `now`, else take the earliest window of either
 * tier. Overridable per settings version via `priority_lookahead_hours`.
 */
export const DEFAULT_PRIORITY_LOOKAHEAD_HOURS = 48;

/** A config that yields no window in two weeks is broken, not "wait longer". */
const MAX_SCAN_DAYS = 14;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type DayKey = (typeof DAY_KEYS)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export class InvalidTimeZoneError extends Error {
  constructor(timeZone: unknown) {
    super(`invalid IANA timezone: ${JSON.stringify(timeZone)}`);
    this.name = "InvalidTimeZoneError";
  }
}

export class SendWindowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendWindowConfigError";
  }
}

// ---------------------------------------------------------------------------
// Timezone arithmetic on Node's Intl — no date library.
// ---------------------------------------------------------------------------

type CivilDate = { year: number; month: number; day: number };

type ZonedParts = CivilDate & { hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function assertTimeZone(timeZone: string): void {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new InvalidTimeZoneError(timeZone);
  }
  try {
    formatterFor(timeZone);
  } catch {
    throw new InvalidTimeZoneError(timeZone);
  }
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") {
      parts[p.type] = Number(p.value);
    }
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** UTC offset of `timeZone` at `instant`, in ms (local = utc + offset). */
function offsetMs(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const p = zonedParts(new Date(whole), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * Local wall time → UTC instant. Two passes resolve the offset across a DST
 * boundary. A wall time that does not exist (spring-forward gap) moves
 * forward by the gap, e.g. 03:30 on a 03:00→04:00 night becomes 04:30.
 */
function zonedTimeToUtc(date: CivilDate, hour: number, minute: number, timeZone: string): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let t = wall - offsetMs(wall, timeZone);
  t = wall - offsetMs(t, timeZone);
  const p = zonedParts(new Date(t), timeZone);
  if (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) !== wall) {
    t = wall - offsetMs(wall - DAY_MS, timeZone);
  }
  return new Date(t);
}

function addDays(date: CivilDate, days: number): CivilDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function dayKey(date: CivilDate): DayKey {
  return DAY_KEYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
}

function formatCivil(date: CivilDate): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

function parseHHMM(value: string, field: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) {
    throw new SendWindowConfigError(`${field}: expected HH:MM, got ${JSON.stringify(value)}`);
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parseDays(days: readonly string[], field: string): Set<DayKey> {
  const out = new Set<DayKey>();
  for (const raw of days) {
    const key = raw.trim().toLowerCase();
    if (!(DAY_KEYS as readonly string[]).includes(key)) {
      throw new SendWindowConfigError(`${field}: unknown day ${JSON.stringify(raw)}`);
    }
    out.add(key as DayKey);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The next window a message to a recipient in `timeZone` may go out in.
 *
 * Priority days use `window_local`, secondary days `secondary_window_local`;
 * a day listed in both is priority. `weekend: false` excludes Sat/Sun even if
 * listed. Window ends are exclusive. Tier choice: the next priority window if
 * it opens within the lookahead, otherwise the earliest window of either tier.
 */
export function nextSendWindow(now: Date, timeZone: string, cfg: SendWindowsConfig): SendWindow {
  assertTimeZone(timeZone);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new SendWindowConfigError("now is not a valid Date");
  }

  const priorityDays = parseDays(cfg.priority_days, "priority_days");
  const secondaryDays = parseDays(cfg.secondary_days, "secondary_days");
  const priorityWindow = [
    parseHHMM(cfg.window_local[0], "window_local[0]"),
    parseHHMM(cfg.window_local[1], "window_local[1]"),
  ] as const;
  const secondaryWindow = [
    parseHHMM(cfg.secondary_window_local[0], "secondary_window_local[0]"),
    parseHHMM(cfg.secondary_window_local[1], "secondary_window_local[1]"),
  ] as const;
  const lookaheadMs = (cfg.priority_lookahead_hours ?? DEFAULT_PRIORITY_LOOKAHEAD_HOURS) * HOUR_MS;

  const today = zonedParts(now, timeZone);
  let firstAny: SendWindow | null = null;
  let firstPriority: SendWindow | null = null;

  for (let k = 0; k <= MAX_SCAN_DAYS && !firstPriority; k++) {
    const date = addDays(today, k);
    const dow = dayKey(date);
    if (!cfg.weekend && (dow === "sat" || dow === "sun")) {
      continue;
    }
    const tier: WindowTier | null = priorityDays.has(dow)
      ? "priority"
      : secondaryDays.has(dow)
        ? "secondary"
        : null;
    if (!tier) {
      continue;
    }
    const [open, close] = tier === "priority" ? priorityWindow : secondaryWindow;
    const opensAt = zonedTimeToUtc(date, open.hour, open.minute, timeZone);
    const end = zonedTimeToUtc(date, close.hour, close.minute, timeZone);
    if (end.getTime() <= opensAt.getTime()) {
      throw new SendWindowConfigError(`${tier} window closes before it opens on ${formatCivil(date)}`);
    }
    if (end.getTime() <= nowMs) {
      continue;
    }
    const window: SendWindow = {
      start: new Date(Math.max(opensAt.getTime(), nowMs)),
      opensAt,
      end,
      tier,
      localDate: formatCivil(date),
      timeZone,
    };
    firstAny ??= window;
    if (tier === "priority") {
      firstPriority = window;
    }
  }

  if (firstPriority && firstPriority.start.getTime() - nowMs <= lookaheadMs) {
    return firstPriority;
  }
  if (firstAny) {
    return firstAny;
  }
  throw new SendWindowConfigError(`no send window within ${MAX_SCAN_DAYS} days`);
}

export type JitteredSend = {
  /** Centre of the jitter range. */
  base: Date;
  sendAt: Date;
};

/**
 * The window's earliest instant with ±jitter applied, always inside the
 * window: base = start + J (or the window's midpoint when it is shorter than
 * 2J), sendAt = base + U(−J, +J). Spreading a day's volume across the window
 * is the send stage's job (U5), not this function's.
 */
export function jitteredSendAt(
  window: Pick<SendWindow, "start" | "end">,
  jitterMinutes: number,
  rng: () => number = Math.random,
): JitteredSend {
  const start = window.start.getTime();
  const span = window.end.getTime() - start;
  if (span <= 0) {
    throw new SendWindowConfigError("window is empty");
  }
  const j = Math.min(Math.max(0, jitterMinutes) * MINUTE_MS, Math.floor(span / 2));
  const base = start + j;
  const offset = (rng() * 2 - 1) * j;
  const sendAt = Math.min(Math.max(Math.round(base + offset), start), window.end.getTime() - 1);
  return { base: new Date(base), sendAt: new Date(sendAt) };
}

function parseIsoDate(value: string, field: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    throw new SendWindowConfigError(`${field}: expected YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Daily quota on `onDate` for an inbox that began cold sending on
 * `rampStartedOn`: start_quota, +ramp_step every ramp_every_days, capped at
 * max_quota. Null when the ramp has not started (unknown is null, never 0).
 */
export function rampQuota(ramp: EmailInboxRamp, rampStartedOn: string | null, onDate: string): number | null {
  if (rampStartedOn === null) {
    return null;
  }
  const days = Math.round((parseIsoDate(onDate, "onDate") - parseIsoDate(rampStartedOn, "rampStartedOn")) / DAY_MS);
  if (days < 0) {
    return null;
  }
  const steps = Math.floor(days / ramp.ramp_every_days);
  return Math.min(ramp.max_quota, ramp.start_quota + ramp.ramp_step * steps);
}

/** Capacity is counted per sender per UTC day (CLAUDE.md: timestamps in UTC). */
export function ledgerDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
