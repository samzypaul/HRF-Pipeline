"use client";

import { useState } from "react";

export default function HealthCheck() {
  const [state, setState] = useState<{ loading?: boolean; result?: Record<string, unknown> }>({});
  async function run() {
    setState({ loading: true });
    try {
      const res = await fetch("/api/health/hfr", { cache: "no-store" });
      setState({ result: await res.json() });
    } catch (e) {
      setState({ result: { ok: false, error: String(e) } });
    }
  }
  const r = state.result;
  return (
    <div className="text-sm">
      <button className="btn" onClick={run} disabled={state.loading}>
        {state.loading ? "Checking…" : "Check HFR portal"}
      </button>
      {r && (
        <div className={`mt-2 rounded-md p-2 text-xs ${r.ok ? "bg-high/10 text-high" : "bg-low/10 text-low"}`}>
          {r.ok
            ? `Reachable: ${r.rows} rows returned, portal reports ${Number(r.portalTotal).toLocaleString()} facilities (${r.ms} ms).`
            : `Not reachable: ${String(r.error ?? "no rows returned")}. If this persists, run the scraper from your computer (scripts/worker.ts).`}
        </div>
      )}
    </div>
  );
}
