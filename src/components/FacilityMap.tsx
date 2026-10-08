"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const COLORS: Record<string, string> = {
  high: "#1a7f4b",
  medium: "#d69e2e",
  low: "#c0392b",
  unchecked: "#8a94a3",
};

/** All facilities as points coloured by confidence. Uses free OpenFreeMap tiles (no key). */
export default function FacilityMap({ query }: { query: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [35.0, -6.3],
      zoom: 5,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", async () => {
      try {
        const res = await fetch(`/api/facilities?${query}`);
        if (!res.ok) throw new Error(`Could not load facilities (${res.status})`);
        const data = await res.json();
        setCount(data.features.length);
        map.addSource("facilities", { type: "geojson", data });
        map.addLayer({
          id: "facilities",
          type: "circle",
          source: "facilities",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 10, 5, 14, 8],
            "circle-color": ["match", ["get", "confidence"], "high", COLORS.high, "medium", COLORS.medium, "low", COLORS.low, COLORS.unchecked],
            "circle-stroke-width": 0.6,
            "circle-stroke-color": "#ffffff",
            "circle-opacity": 0.9,
          },
        });
        map.on("click", "facilities", (e: maplibregl.MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (!f || f.geometry.type !== "Point") return;
          const p = f.properties as Record<string, string>;
          const el = document.createElement("div");
          el.style.fontSize = "13px";
          const title = document.createElement("a");
          title.href = `/facility/${encodeURIComponent(p.code)}`;
          title.textContent = `${p.name} (${p.code})`;
          title.style.fontWeight = "600";
          title.style.color = "#0f6e5b";
          const meta = document.createElement("div");
          meta.textContent = `${p.type ?? ""} · ${p.confidence} confidence · location from ${p.source}`;
          meta.style.color = "#5b6573";
          el.append(title, meta);
          new maplibregl.Popup({ offset: 8 }).setLngLat(f.geometry.coordinates as [number, number]).setDOMContent(el).addTo(map);
        });
        map.on("mouseenter", "facilities", () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", "facilities", () => (map.getCanvas().style.cursor = ""));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => map.remove();
  }, [query]);

  return (
    <div className="relative">
      <div ref={ref} className="h-[70vh] w-full overflow-hidden rounded-lg border border-line" />
      <div className="absolute bottom-3 left-3 rounded-md bg-white/95 px-3 py-2 text-xs shadow">
        <div className="mb-1 font-semibold">{count == null ? "Loading…" : `${count.toLocaleString()} facilities`}</div>
        {Object.entries(COLORS).map(([k, c]) => (
          <div key={k} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
            {k}
          </div>
        ))}
        {error && <div className="mt-1 text-low">{error}</div>}
      </div>
    </div>
  );
}
