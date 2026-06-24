/**
 * An OpenAI-compatible chat-completions {@link JudgeProvider} for Phase D.
 *
 * Works against any endpoint that speaks the `/v1/chat/completions` shape:
 *  - LOCAL (privacy-preserving, recommended): Ollama
 *    `http://localhost:11434/v1/chat/completions`, LM Studio, llama.cpp server.
 *  - HOSTED: OpenAI, OpenRouter, etc. (an API key leaves the box — opt-in only).
 *
 * Self-attribution note (06 §6.5): prefer a model from a *different* family than
 * the one that produced the work being judged.
 */
import type { JudgeProvider } from './judge.js';

export interface HttpJudgeConfig {
  /** Full chat-completions URL (e.g. http://localhost:11434/v1/chat/completions). */
  readonly endpoint: string;
  /** Model name as the endpoint expects it (e.g. "llama3.1", "gpt-4o-mini"). */
  readonly model: string;
  /** Bearer token; omit for local endpoints that need none. */
  readonly apiKey?: string;
  /** Request timeout in ms (default 20s) — a slow judge must not stall collection. */
  readonly timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Build a provider that POSTs a single user message at temperature 0 and returns
 * the assistant text. Throws on non-2xx or timeout — `runJudge` catches it and
 * degrades to no-signal.
 */
export function createHttpJudgeProvider(cfg: HttpJudgeConfig): JudgeProvider {
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  return {
    async complete(prompt: string): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(cfg.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`judge endpoint returned HTTP ${res.status}`);
        }
        const data = (await res.json()) as ChatCompletionResponse;
        return data.choices?.[0]?.message?.content ?? '';
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
