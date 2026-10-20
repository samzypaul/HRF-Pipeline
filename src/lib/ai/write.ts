import { env } from "../env";
import { countCall } from "../geo/usage";
import { geminiJson, type GeminiSchema } from "./gemini";

export interface Recommendation {
  title: string;
  detail: string;
  priority?: "high" | "medium" | "low";
}

/** Output shape shared by the daily and weekly writers. */
export const REPORT_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    summary_md: {
      type: "STRING",
      description:
        "Markdown summary for Ministry of Health and partner staff: 2–4 short sections (What changed, Data quality, Needs attention). Plain language, no more than 350 words.",
    },
    anomalies: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          detail: { type: "STRING" },
          facility_codes: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["title", "detail"],
      },
    },
    recommendations: {
      type: "ARRAY",
      description: "Concrete next actions for staff, most important first (max 6). Each must follow from the digest.",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          detail: { type: "STRING" },
          priority: { type: "STRING", enum: ["high", "medium", "low"] },
        },
        required: ["title", "detail", "priority"],
      },
    },
    review_list: {
      type: "ARRAY",
      description: "Facilities a person should check, most important first (max 15).",
      items: {
        type: "OBJECT",
        properties: { facility_code: { type: "STRING" }, reason: { type: "STRING" } },
        required: ["facility_code", "reason"],
      },
    },
  },
  required: ["summary_md", "anomalies", "recommendations", "review_list"],
};

export const RULES = `Rules:
- Use ONLY the numbers and facts in the JSON digest. Never estimate, extrapolate or invent figures.
- If something is zero or missing, say so plainly; do not speculate about causes beyond "may indicate".
- Refer to facilities by name and facility code exactly as given.
- Flag reconciliation gaps (portal total vs rows seen, list task failures, facilities without a ward).
- Recommendations are specific actions (who or what to check, and why), not general advice.`;

export interface AiReport {
  summary: string;
  anomalies: unknown[];
  recommendations: unknown[];
  reviewList: unknown[];
  model: string | null;
}

/** Ask Gemini for the report body; without a key, return the plain fallback summary. */
export async function writeReport(system: string, prompt: string, fallback: () => string): Promise<AiReport> {
  if (!env.geminiKey) return { summary: fallback(), anomalies: [], recommendations: [], reviewList: [], model: null };
  let result;
  try {
    result = await geminiJson<{ summary_md: string; anomalies: unknown[]; recommendations: unknown[]; review_list: unknown[] }>({
      system,
      prompt,
      schema: REPORT_SCHEMA,
    });
  } catch (e) {
    // A Gemini outage or exhausted quota must not cost us the report: write the plain summary instead.
    console.error("[reports] Gemini failed, using the plain summary", e);
    return { summary: fallback(), anomalies: [], recommendations: [], reviewList: [], model: null };
  }
  const { data, model } = result;
  await countCall("gemini");
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    summary: data.summary_md ?? "",
    anomalies: list(data.anomalies),
    recommendations: list(data.recommendations),
    reviewList: list(data.review_list),
    model,
  };
}

