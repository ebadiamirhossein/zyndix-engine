const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

/** Sonnet 4.6 list pricing (USD per token) — used for estimates only. */
const DEFAULT_INPUT_USD_PER_TOKEN = 3 / 1_000_000;
const DEFAULT_OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

export class AnthropicApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Anthropic API error (${status}): ${body}`);
    this.name = "AnthropicApiError";
    this.status = status;
    this.body = body;
  }
}

export class AnthropicJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicJsonError";
  }
}

export type AnthropicCompleteParams = {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
};

export type AnthropicCompleteResult = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
};

export type AnthropicClient = ReturnType<typeof createAnthropicClient>;

function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }
  return key;
}

function defaultModel(): string {
  return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    return fenceMatch[1]!.trim();
  }
  return trimmed;
}

export function parseJsonText(text: string): unknown {
  const stripped = stripMarkdownFences(text);
  try {
    return JSON.parse(stripped);
  } catch {
    throw new AnthropicJsonError(
      `Model returned non-JSON (first 200 chars): ${stripped.slice(0, 200)}`,
    );
  }
}

export function estimateAnthropicCostUsd(
  inputTokens: number,
  outputTokens: number,
): number {
  const inputRate = Number(process.env.ANTHROPIC_INPUT_USD_PER_TOKEN);
  const outputRate = Number(process.env.ANTHROPIC_OUTPUT_USD_PER_TOKEN);
  const inPerToken = Number.isFinite(inputRate) ? inputRate : DEFAULT_INPUT_USD_PER_TOKEN;
  const outPerToken = Number.isFinite(outputRate)
    ? outputRate
    : DEFAULT_OUTPUT_USD_PER_TOKEN;
  return inputTokens * inPerToken + outputTokens * outPerToken;
}

type MessagesResponse = {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
};

async function messagesRequest(body: Record<string, unknown>): Promise<MessagesResponse> {
  const apiKey = requireApiKey();
  const response = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new AnthropicApiError(response.status, rawBody);
  }

  return JSON.parse(rawBody) as MessagesResponse;
}

export function createAnthropicClient() {
  async function complete(
    params: AnthropicCompleteParams,
  ): Promise<AnthropicCompleteResult> {
    const model = params.model ?? defaultModel();
    const body = {
      model,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.1,
      system: params.system,
      messages: [{ role: "user", content: params.user }],
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const json = await messagesRequest(body);
        const textBlock = json.content?.find((block) => block.type === "text");
        const text = textBlock?.text?.trim();
        if (!text) {
          throw new AnthropicApiError(200, "Empty text content in Anthropic response");
        }

        const inputTokens = json.usage?.input_tokens ?? 0;
        const outputTokens = json.usage?.output_tokens ?? 0;

        return {
          text,
          model: json.model ?? model,
          inputTokens,
          outputTokens,
          estCostUsd: estimateAnthropicCostUsd(inputTokens, outputTokens),
        };
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await sleep(1500);
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  return { complete, parseJsonText, stripMarkdownFences };
}
