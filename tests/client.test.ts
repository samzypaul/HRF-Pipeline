import { beforeEach, describe, expect, it, vi } from "vitest";
import { HfrBlockedError, HfrClient } from "@/lib/hfr/client";

function makeClient(responses: Array<{ status: number; body?: string } | Error>) {
  let clock = 0;
  const sleeps: number[] = [];
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return new Response(r.body ?? "ok", { status: r.status });
  }) as unknown as typeof fetch;
  const client = new HfrClient({
    baseUrl: "https://example.test/web/index.php",
    rateMs: 1000,
    contactEmail: "test@example.com",
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { client, sleeps, calls, fetchImpl };
}

describe("HfrClient", () => {
  beforeEach(() => HfrClient.resetThrottle());

  it("spaces requests at least rateMs apart", async () => {
    const { client, sleeps } = makeClient([{ status: 200 }, { status: 200 }, { status: 200 }]);
    await client.get("portal/a");
    await client.get("portal/b");
    await client.get("portal/c");
    expect(sleeps.filter((s) => s > 0)).toEqual([1000, 1000]);
  });

  it("builds list URLs with the ward filter and page size", async () => {
    const { client, calls } = makeClient([{ status: 200 }]);
    await client.listPage({ page: 3, ward: "TZ.CL.DO.BA.6.7" });
    const u = new URL(calls[0]);
    expect(u.searchParams.get("r")).toBe("portal/health-facility-list");
    expect(u.searchParams.getAll("ward[]")).toEqual(["TZ.CL.DO.BA.6.7"]);
    expect(u.searchParams.get("per-page")).toBe("50");
    expect(u.searchParams.get("page")).toBe("3");
  });

  it("retries 5xx and network errors with backoff, then succeeds", async () => {
    const { client, sleeps } = makeClient([{ status: 503 }, new Error("ECONNRESET"), { status: 200, body: "fine" }]);
    await expect(client.get("portal/x")).resolves.toBe("fine");
    expect(sleeps).toContain(2000);
    expect(sleeps).toContain(4000);
  });

  it("throws HfrBlockedError immediately on 403", async () => {
    const { client, fetchImpl } = makeClient([{ status: 403 }, { status: 200 }]);
    await expect(client.get("portal/x")).rejects.toBeInstanceOf(HfrBlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after repeated 429s", async () => {
    const { client } = makeClient([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    await expect(client.get("portal/x")).rejects.toBeInstanceOf(HfrBlockedError);
  });
});
