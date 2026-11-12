import { readFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { AppEnv } from "../config/env.js";

export type AiProvider = "gemini" | "openrouter";

export interface StageUsageRecord {
  stage: string;
  provider: AiProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ProviderCallResult {
  rawText: string;
  usedModel: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface AttemptTarget {
  provider: AiProvider;
  model: string;
}

function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function sanitizeJsonSchemaForOpenRouter(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

function classifyRetryability(message: string): { isRateLimit: boolean; isTransient: boolean } {
  const lower = message.toLowerCase();
  const isRateLimit = message.includes("429") || lower.includes("rate limit") || lower.includes("quota");
  const isTransient =
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504") ||
    lower.includes("high demand") ||
    lower.includes("overloaded") ||
    lower.includes("timed out") ||
    lower.includes("timeout");
  return { isRateLimit, isTransient };
}

export function selectFirstHalfTarget(env: AppEnv): AttemptTarget {
  if (env.OPENROUTER_API_KEY) {
    return { provider: "openrouter", model: env.OPENROUTER_MODEL };
  }
  return { provider: "gemini", model: env.GEMINI_MODEL_LIGHT };
}

export class GeminiPipelineClient {
  private readonly geminiSdk: GoogleGenAI | null;
  private sharedRulesCache: string | null = null;
  public readonly usageRecords: StageUsageRecord[] = [];

  constructor(private readonly env: AppEnv) {
    if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
      throw new Error("Neither GEMINI_API_KEY nor OPENROUTER_API_KEY is set in .env before running AI stages.");
    }
    this.geminiSdk = env.GEMINI_API_KEY
      ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, apiVersion: "v1beta" })
      : null;
  }

  private async loadPromptFile(name: string): Promise<string> {
    const p = path.resolve("src", "ai", "prompts", `${name}.md`);
    return readFile(p, "utf8");
  }

  private async getSystemInstruction(promptName: string): Promise<string> {
    if (!this.sharedRulesCache) {
      this.sharedRulesCache = await this.loadPromptFile("shared-rules");
    }
    const stagePrompt = await this.loadPromptFile(promptName);
    return `${this.sharedRulesCache}\n\n---\n\n${stagePrompt}`;
  }

  private buildAttemptPlan(primaryProvider: AiProvider, primaryModel: string): AttemptTarget[] {
    const plan: AttemptTarget[] = [];
    const pushUnique = (provider: AiProvider, model: string) => {
      if (provider === "gemini" && !this.geminiSdk) return;
      if (provider === "openrouter" && !this.env.OPENROUTER_API_KEY) return;
      if (!plan.some((t) => t.provider === provider && t.model === model)) {
        plan.push({ provider, model });
      }
    };

    pushUnique(primaryProvider, primaryModel);
    if (primaryProvider === "openrouter") {
      // Fall back to Gemini LIGHT / FALLBACK only if OpenRouter cannot serve the stage
      pushUnique("gemini", this.env.GEMINI_MODEL_LIGHT);
      pushUnique("gemini", this.env.GEMINI_MODEL_FALLBACK);
    } else {
      pushUnique("gemini", this.env.GEMINI_MODEL_FALLBACK);
      pushUnique("openrouter", this.env.OPENROUTER_MODEL);
    }
    return plan;
  }

  private async callGemini(params: {
    stage: string;
    model: string;
    systemInstruction: string;
    inputText: string;
    jsonSchema: Record<string, unknown>;
    maxOutputTokens: number;
    temperature: number;
  }): Promise<ProviderCallResult> {
    if (!this.geminiSdk) {
      throw new Error("GEMINI_API_KEY is missing.");
    }
    const interaction = await this.geminiSdk.interactions.create(
      {
        model: params.model,
        system_instruction: params.systemInstruction,
        input: params.inputText,
        store: false,
        response_mime_type: "application/json",
        response_format: params.jsonSchema,
        generation_config: {
          max_output_tokens: params.maxOutputTokens,
          temperature: params.temperature,
        },
      },
      {
        timeout_ms: 25_000,
        retries: { strategy: "none" },
      },
    );

    const rawText = interaction.output_text?.trim() ?? "";
    if (!rawText) {
      throw new Error(`Empty response text from Gemini in stage "${params.stage}"`);
    }

    const usage = interaction.usage;
    return {
      rawText,
      usedModel: params.model,
      inputTokens: usage?.total_input_tokens ?? 0,
      outputTokens: usage?.total_output_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    };
  }

  private async callOpenRouter(params: {
    stage: string;
    model: string;
    promptName: string;
    systemInstruction: string;
    inputText: string;
    jsonSchema: Record<string, unknown>;
    maxOutputTokens: number;
    temperature: number;
  }): Promise<ProviderCallResult> {
    if (!this.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is missing.");
    }

    const cleanSchema = sanitizeJsonSchemaForOpenRouter(params.jsonSchema);
    const sendRequest = async (reasoning: Record<string, unknown>, maxTokens: number) => {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "X-Title": "NSP Brand Intelligence Engine",
        },
        body: JSON.stringify({
          model: params.model,
          messages: [
            {
              role: "system",
              content: `${params.systemInstruction}\n\nReturn ONLY a single valid JSON object conforming exactly to this JSON Schema (no markdown fences or commentary):\n${JSON.stringify(cleanSchema)}`,
            },
            { role: "user", content: params.inputText },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: params.promptName.replace(/[^a-zA-Z0-9_-]/g, "_"),
              strict: false,
              schema: cleanSchema,
            },
          },
          reasoning,
          max_tokens: maxTokens,
          temperature: params.temperature,
        }),
        signal: AbortSignal.timeout(35_000),
      });

      const bodyText = await response.text();
      let parsedBody: {
        model?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        error?: { message?: string; code?: number };
      };
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        throw new Error(`OpenRouter HTTP ${response.status} non-JSON response: ${bodyText.slice(0, 200)}`);
      }
      return { response, parsedBody };
    };

    let { response, parsedBody } = await sendRequest({ enabled: false }, Math.max(params.maxOutputTokens, 4096));
    const initialErr = parsedBody.error?.message ?? "";
    if (!response.ok && response.status === 400 && initialErr.toLowerCase().includes("reasoning")) {
      ({ response, parsedBody } = await sendRequest({ effort: "low", exclude: true }, 6000));
    }

    if (!response.ok || parsedBody.error) {
      const errMsg = parsedBody.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`OpenRouter ${response.status}: ${errMsg}`);
    }

    const rawText = parsedBody.choices?.[0]?.message?.content?.trim() ?? "";
    if (!rawText) {
      throw new Error(`Empty response text from OpenRouter (${parsedBody.model ?? params.model}) in stage "${params.stage}"`);
    }

    const usage = parsedBody.usage;
    return {
      rawText,
      usedModel: parsedBody.model ?? params.model,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    };
  }

  async generateStructured<T extends z.ZodTypeAny>(params: {
    stage: string;
    provider?: AiProvider;
    model: string;
    promptName: string;
    inputPayload: unknown;
    schema: T;
    maxOutputTokens?: number;
    temperature?: number;
  }): Promise<z.infer<T>> {
    const systemInstruction = await this.getSystemInstruction(params.promptName);
    const jsonSchema = z.toJSONSchema(params.schema) as Record<string, unknown>;
    const inputText = JSON.stringify(params.inputPayload);
    const primaryProvider = params.provider ?? "gemini";
    const plan = this.buildAttemptPlan(primaryProvider, params.model);

    if (plan.length === 0) {
      throw new Error(`No configured AI provider available for stage "${params.stage}"`);
    }

    const backoffMs = [2000, 5000];
    let lastError: unknown;

    for (let targetIdx = 0; targetIdx < plan.length; targetIdx++) {
      const target = plan[targetIdx]!;
      const maxAttempts = target.provider === "gemini" ? 3 : 2;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const result =
            target.provider === "openrouter"
              ? await this.callOpenRouter({
                  stage: params.stage,
                  model: target.model,
                  promptName: params.promptName,
                  systemInstruction,
                  inputText,
                  jsonSchema,
                  maxOutputTokens: params.maxOutputTokens ?? 2048,
                  temperature: params.temperature ?? 0.3,
                })
              : await this.callGemini({
                  stage: params.stage,
                  model: target.model,
                  systemInstruction,
                  inputText,
                  jsonSchema,
                  maxOutputTokens: params.maxOutputTokens ?? 2048,
                  temperature: params.temperature ?? 0.3,
                });

          const parsedJson = JSON.parse(stripJsonCodeFences(result.rawText));
          const validated = params.schema.parse(parsedJson);

          this.usageRecords.push({
            stage: params.stage,
            provider: target.provider,
            model: result.usedModel,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            totalTokens: result.totalTokens,
          });

          return validated;
        } catch (err) {
          lastError = err;
          const msg = err instanceof Error ? err.message : String(err);
          const { isRateLimit, isTransient } = classifyRetryability(msg);

          if (isRateLimit) {
            // Never retry the same rate-limited model; move directly to fallback target
            break;
          }

          if (attempt < maxAttempts - 1 && (isTransient || target.provider === "openrouter")) {
            const waitMs = backoffMs[attempt] ?? 2000;
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          break;
        }
      }

      if (targetIdx < plan.length - 1) {
        const nextTarget = plan[targetIdx + 1]!;
        console.warn(
          `  [AI Fallback] ${params.stage}: ${target.provider}/"${target.model}" failed (${lastError instanceof Error ? lastError.message : String(lastError)}), falling back to ${nextTarget.provider}/"${nextTarget.model}"`,
        );
      }
    }

    throw new Error(
      `Stage "${params.stage}" failed after fallbacks: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  getTokenSummary() {
    return this.usageRecords.reduce(
      (acc, r) => {
        acc.calls += 1;
        acc.inputTokens += r.inputTokens;
        acc.outputTokens += r.outputTokens;
        acc.totalTokens += r.totalTokens;
        return acc;
      },
      { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
  }
}
