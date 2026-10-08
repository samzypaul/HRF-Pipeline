import { describe, expect, it } from "vitest";
import { classifyChange, diffFields } from "@/lib/diff/fields";
import { extractNumbers, verifyNumbers } from "@/lib/ai/verify";
import { hashOf, stableStringify } from "@/lib/util";
import { signToken, verifyToken } from "@/lib/auth";

describe("diff", () => {
  it("lists changed fields only", () => {
    expect(diffFields({ a: 1, b: "x", c: null }, { a: 1, b: "y", c: undefined })).toEqual([{ field: "b", from: "x", to: "y" }]);
  });
  it("classifies closures and reopenings", () => {
    expect(classifyChange([{ field: "operating_status", from: "Operating", to: "Closed" }])).toBe("closed");
    expect(classifyChange([{ field: "operating_status", from: "Closed", to: "Operating" }])).toBe("reopened");
    expect(classifyChange([{ field: "name", from: "A", to: "B" }])).toBe("updated");
  });
  it("hashes independently of key order", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(hashOf({ x: 1, y: 2 })).toBe(hashOf({ y: 2, x: 1 }));
  });
});

describe("AI number verification", () => {
  const digest = { changes: { new: 37, closed: 4, updated: 120 }, totals: { portal_reported_total: 14363, rows_seen_this_run: 14350 } };
  it("extracts numbers but skips facility codes and dates", () => {
    expect(extractNumbers("37 new (120284-5) on 2026-10-05, total 14,363 and 12.5%")).toEqual([37, 14363, 12.5]);
  });
  it("passes when every number is in the data (or derived from it)", () => {
    const v = verifyNumbers(["37 new facilities, 120 updated. The portal lists 14,363; 13 were not seen."], digest);
    expect(v.ok).toBe(true);
  });
  it("fails on an invented number", () => {
    const v = verifyNumbers(["About 950 facilities changed this week."], digest);
    expect(v.ok).toBe(false);
    expect(v.unknown).toContain("950");
  });
});

describe("signed tokens", () => {
  it("round-trips and rejects tampering, wrong purpose and expiry", async () => {
    const secret = "s3cret-for-tests-only";
    const t = await signToken({ email: "a@b.org", purpose: "session", exp: Date.now() / 1000 + 60 }, secret);
    expect((await verifyToken(t, secret, "session"))?.email).toBe("a@b.org");
    expect(await verifyToken(t, secret, "link")).toBeNull();
    expect(await verifyToken(t, "other-secret", "session")).toBeNull();
    expect(await verifyToken(t.slice(0, -2) + "xx", secret, "session")).toBeNull();
    const old = await signToken({ email: "a@b.org", purpose: "session", exp: 1 }, secret);
    expect(await verifyToken(old, secret, "session")).toBeNull();
  });
});
