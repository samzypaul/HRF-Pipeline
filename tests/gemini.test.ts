import { describe, expect, it, vi } from "vitest";
import { geminiJson, GeminiError } from "@/lib/ai/gemini";

const schema = { type: "OBJECT" as const, properties: { summary_md: { type: "STRING" as const } }, required: ["summary_md"] };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("geminiJson", () => {
  it("sends a JSON-schema request and parses the answer", async () => {
    const f = fakeFetch(200, { candidates: [{ content: { parts: [{ text: '{"summary_md":"## What changed\\n- 3 new"}' }] }, finishReason: "STOP" }] });
    const r = await geminiJson<{ summary_md: string }>({ system: "sys", prompt: "p", schema, apiKey: "k", model: "gemini-test", fetchImpl: f });
    expect(r.data.summary_md).toContain("3 new");
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(String(init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(schema);
    expect(body.systemInstruction.parts[0].text).toBe("sys");
  });

  it("tolerates a fenced JSON answer", async () => {
    const f = fakeFetch(200, { candidates: [{ content: { parts: [{ text: '```json\n{"summary_md":"ok"}\n```' }] } }] });
    expect((await geminiJson<{ summary_md: string }>({ system: "s", prompt: "p", schema, apiKey: "k", fetchImpl: f })).data.summary_md).toBe("ok");
  });

  it("raises clear errors", async () => {
    await expect(geminiJson({ system: "s", prompt: "p", schema, apiKey: "k", fetchImpl: fakeFetch(400, { error: { message: "bad key" } }) })).rejects.toThrow(/400/);
    await expect(geminiJson({ system: "s", prompt: "p", schema, apiKey: "k", fetchImpl: fakeFetch(200, { candidates: [{ finishReason: "SAFETY" }] }) })).rejects.toThrow(/SAFETY/);
    await expect(geminiJson({ system: "s", prompt: "p", schema, apiKey: "k", fetchImpl: fakeFetch(200, { candidates: [{ content: { parts: [{ text: "not json" }] } }] }) })).rejects.toBeInstanceOf(GeminiError);
  });
});
