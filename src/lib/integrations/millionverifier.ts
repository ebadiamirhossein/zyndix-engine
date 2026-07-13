import { z } from "zod";

import type { EmailStatus } from "@/types/enums";

const MILLIONVERIFIER_BASE_URL = "https://api.millionverifier.com/api/v3/";

export class MillionVerifierApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`MillionVerifier API error (${status}): ${body}`);
    this.name = "MillionVerifierApiError";
    this.status = status;
    this.body = body;
  }
}

export type MillionVerifierRawResult =
  | "ok"
  | "invalid"
  | "disposable"
  | "catch_all"
  | "accept_all"
  | "unknown"
  | "error";

const millionVerifierResponseSchema = z
  .object({
    email: z.string().optional().nullable(),
    quality: z.string().optional().nullable(),
    result: z.string().min(1),
    resultcode: z.number().optional().nullable(),
    subresult: z.string().optional().nullable(),
    free: z.boolean().optional().nullable(),
    role: z.boolean().optional().nullable(),
    didyoumean: z.string().optional().nullable(),
    error: z.string().optional().nullable(),
    credits: z.number().optional().nullable(),
    executiontime: z.number().optional().nullable(),
    livemode: z.boolean().optional().nullable(),
  })
  .strict();

export type MillionVerifierVerifyResult = {
  email: string;
  raw_result: MillionVerifierRawResult;
  email_status: EmailStatus;
  quality: string | null;
  didyoumean: string | null;
  subresult: string | null;
  resultcode: number | null;
  credits: number | null;
};

function requireApiKey(): string {
  const key = process.env.MILLIONVERIFIER_API_KEY;
  if (!key) {
    throw new Error("Missing MILLIONVERIFIER_API_KEY");
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapResultToEmailStatus(raw: MillionVerifierRawResult): EmailStatus {
  switch (raw) {
    case "ok":
      return "valid";
    case "invalid":
    case "disposable":
      return "invalid";
    case "catch_all":
    case "accept_all":
    case "unknown":
      return "catch_all";
    default:
      return "catch_all";
  }
}

export type MillionVerifierClient = ReturnType<typeof createMillionVerifierClient>;

export function createMillionVerifierClient() {
  async function verifyEmail(email: string): Promise<MillionVerifierVerifyResult> {
    const apiKey = requireApiKey();
    const url = new URL(MILLIONVERIFIER_BASE_URL);
    url.searchParams.set("api", apiKey);
    url.searchParams.set("email", email);

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await sleep(1500);
      }
      try {
        const response = await fetch(url.toString(), {
          method: "GET",
          headers: { accept: "application/json" },
        });

        const text = await response.text();
        if (!response.ok) {
          // Retry once on 5xx only.
          if (attempt === 0 && response.status >= 500) {
            lastError = new MillionVerifierApiError(response.status, text);
            continue;
          }
          throw new MillionVerifierApiError(response.status, text);
        }

        const json = text ? (JSON.parse(text) as unknown) : {};
        const parsed = millionVerifierResponseSchema.parse(json);

        const rawResult = parsed.result as MillionVerifierRawResult;
        const errorMessage = (parsed.error ?? "").trim();
        if (rawResult === "error" || errorMessage.length > 0) {
          throw new Error(
            `MillionVerifier returned error result: result=${rawResult} error="${errorMessage}"`,
          );
        }

        console.log(
          `[millionverifier] email=${email} result=${rawResult} quality=${parsed.quality ?? ""} subresult=${parsed.subresult ?? ""}`,
        );

        return {
          email,
          raw_result: rawResult,
          email_status: mapResultToEmailStatus(rawResult),
          quality: parsed.quality ?? null,
          didyoumean: parsed.didyoumean ?? null,
          subresult: parsed.subresult ?? null,
          resultcode: parsed.resultcode ?? null,
          credits: parsed.credits ?? null,
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return { verifyEmail };
}

