import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

export class CronUnauthorizedError extends Error {
  readonly status = 401;

  constructor(message = "Unauthorized") {
    super(message);
    this.name = "CronUnauthorizedError";
  }
}

/**
 * Vercel sends CRON_SECRET as `Authorization: Bearer <secret>` (Vercel docs,
 * "Securing cron jobs"). Unset secret → refuse. Compared in constant time over
 * sha256 digests (equal length), like the Telegram and Instantly webhooks.
 */
export function assertCron(req: Request): void {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("Authorization");

  if (!secret || auth === null) {
    throw new CronUnauthorizedError();
  }
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const actual = createHash("sha256").update(auth).digest();
  if (!timingSafeEqual(expected, actual)) {
    throw new CronUnauthorizedError();
  }
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
