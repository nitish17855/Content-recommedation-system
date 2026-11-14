import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  GEMINI_API_KEY: z.string().trim().optional().default(""),
  GEMINI_API_KEYS: z.string().trim().optional().default(""),
  GEMINI_MODEL_LIGHT: z.string().trim().min(1).default("gemini-3.5-flash-lite"),
  GEMINI_MODEL_REASONING: z.string().trim().min(1).default("gemini-3.8-flash"),
  GEMINI_MODEL_CRITIC: z.string().trim().min(1).default("gemini-3.8-flash"),
  GEMINI_MODEL_FALLBACK: z.string().trim().min(1).default("gemini-3.5-flash-lite"),
  OPENROUTER_API_KEY: z.string().trim().optional().default(""),
  OPENROUTER_MODEL: z.string().trim().min(1).default("openrouter/free"),
  DATABASE_URL: z.string().trim().optional().default(""),
  LOOKBACK_DAYS: z.coerce.number().int().min(1).max(30).default(14),
  MAX_CLUSTERS_FOR_LLM: z.coerce.number().int().min(1).max(25).default(8),
  REPORT_INTERVAL_DAYS: z.coerce.number().int().min(1).max(60).default(15),
});

export type AppEnv = z.infer<typeof envSchema>;

export function getConfiguredGeminiKeys(env: AppEnv): string[] {
  const raw = [env.GEMINI_API_KEY, ...env.GEMINI_API_KEYS.split(/[,\s;]+/)]
    .map((k) => k.trim())
    .filter(Boolean);
  return Array.from(new Set(raw));
}

export function hasAnyAiKey(env: AppEnv): boolean {
  return getConfiguredGeminiKeys(env).length > 0 || Boolean(env.OPENROUTER_API_KEY);
}

export function loadEnv(): AppEnv {
  return envSchema.parse(process.env);
}
