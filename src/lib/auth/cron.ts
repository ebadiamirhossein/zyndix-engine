import { NextResponse } from "next/server";

export class CronUnauthorizedError extends Error {
  readonly status = 401;

  constructor(message = "Unauthorized") {
    super(message);
    this.name = "CronUnauthorizedError";
  }
}

export function assertCron(req: Request): void {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("Authorization");

  if (!secret || auth !== `Bearer ${secret}`) {
    throw new CronUnauthorizedError();
  }
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
