import { z } from "zod";

export * from "@/lib/validation/external";
export * from "@/lib/validation/jsonb";
export * from "@/lib/validation/llm";

export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `[validation:${context}] ${JSON.stringify(result.error.flatten())}`,
    );
  }
  return result.data;
}
