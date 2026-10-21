import { env } from "../env";

/**
 * Minimal Gemini API client (REST, no SDK): one generateContent call that
 * must return JSON matching `schema`.
 * Docs: https://ai.google.dev/api/generate-content
 */

export type GeminiSchema = {
  type: "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN";
  description?: string;
  enum?: string[];
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
};

export class GeminiError extends Error {}

/** Gemini cannot be used right now (credits used up, quota or rate limit reached, key rejected, model overloaded): stop calling it for a while. */
export class GeminiUnavailable extends GeminiError {}

export async function geminiJson<T>(opts: {
  system: string;
  prompt: string;
  schema: GeminiSchema;
  /** Images sent before the prompt (for example a satellite tile). */
  images?: { mimeType: string; data: string }[];
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ data: T; model: string }> {
  const apiKey = opts.apiKey ?? env.geminiKey;
  if (!apiKey) throw new GeminiError("GEMINI_API_KEY is not set");
  const model = opts.model ?? env.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: [...(opts.images ?? []).map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })), { text: opts.prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: opts.schema,
        temperature: 0.2,
        maxOutputTokens: 4096,
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.text();
  if (res.status === 402 || res.status === 403 || res.status === 429 || res.status === 503) throw new GeminiUnavailable(`Gemini returned ${res.status}: ${body.slice(0, 200)}`);
  if (!res.ok) throw new GeminiError(`Gemini returned ${res.status}: ${body.slice(0, 300)}`);

  const json = JSON.parse(body) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (json.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the prompt: ${json.promptFeedback.blockReason}`);
  const cand = json.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new GeminiError(`Gemini returned no text (finishReason: ${cand?.finishReason ?? "unknown"})`);
  try {
    return { data: JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as T, model };
  } catch {
    throw new GeminiError(`Gemini did not return valid JSON (finishReason: ${cand?.finishReason ?? "unknown"})`);
  }
}
