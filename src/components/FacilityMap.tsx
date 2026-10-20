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

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const ESRI_ATTRIBUTION =
  "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, USGS, NOAA and the GIS user community";

const raster = (
  tiles: string[],
  attribution: string,
  maxzoom: number,
): maplibregl.StyleSpecification["sources"][string] => ({
  type: "raster",
  tiles,
  tileSize: 256,
  maxzoom,
  attribution,
});

/** Base maps, all free and keyless. Streets/Light are vector styles; Satellite and Topography are raster tiles. */
const BASEMAPS = {
  streets: {
    label: "Streets",
    style: "https://tiles.openfreemap.org/styles/liberty" as
      string | maplibregl.StyleSpecification,
  },
  light: {
    label: "Light",
    style: "https://tiles.openfreemap.org/styles/positron" as
      string | maplibregl.StyleSpecification,
  },
  satellite: {
    label: "Satellite",
    style: {
      version: 8,
      sources: {
        imagery: raster(
          [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
          ESRI_ATTRIBUTION,
          18,
        ),
        labels: raster(
          [
            `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
          ],
          ESRI_ATTRIBUTION,
          18,
        ),
      },
      layers: [
        { id: "imagery", type: "raster", source: "imagery" },
        { id: "labels", type: "raster", source: "labels" },
      ],
    } as string | maplibregl.StyleSpecification,
  },
  topography: {
    label: "Topography",
    style: {
      version: 8,
      sources: {
        topo: raster(
          [`${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`],
          ESRI_ATTRIBUTION,
          18,
        ),
      },
      layers: [{ id: "topo", type: "raster", source: "topo" }],
    } as string | maplibregl.StyleSpecification,
  },
};
// With a public ArcGIS key (NEXT_PUBLIC_ARCGIS_API_KEY) the four base maps come from the ArcGIS basemap styles service instead.
const ARCGIS_KEY = process.env.NEXT_PUBLIC_ARCGIS_API_KEY;
const arcgisStyle = (name: string) =>
  `https://basemaps-api.arcgis.com/arcgis/rest/services/styles/v2/styles/arcgis/${name}?token=${ARCGIS_KEY}`;
if (ARCGIS_KEY) {
  BASEMAPS.streets.style = arcgisStyle("streets");
  BASEMAPS.light.style = arcgisStyle("light-gray");
  BASEMAPS.satellite.style = arcgisStyle("imagery");
  BASEMAPS.topography.style = arcgisStyle("topographic");
}

type BasemapKey = keyof typeof BASEMAPS;

/** All facilities as points coloured by confidence, over a choice of base maps (no API key needed). */
export default function FacilityMap({ query }: { query: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [basemap, setBasemap] = useState<BasemapKey>("streets");
  const basemapRef = useRef<BasemapKey>(basemap);
  const appliedRef = useRef<BasemapKey>(basemap); // base map the current map instance was built with
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: BASEMAPS[basemapRef.current].style,
      center: [35.0, -6.3],
      zoom: 5,
      attributionControl: { compact: true },
    });
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    mapRef.current = map;
    appliedRef.current = basemapRef.current;

    type MapData = GeoJSON.FeatureCollection & {
      lookups: Record<
        "wards" | "villages" | "councils" | "regions" | "types" | "sources",
        string[]
      >;
    };
    let data: MapData | null = null;
    // Start downloading the points now, while the base map style is still loading.
    const download: Promise<MapData> = fetch(`/api/facilities?${query}`).then(
      (res) => {
        if (!res.ok)
          throw new Error(`Could not load facilities (${res.status})`);
        return res.json();
      },
    );
    let popup: maplibregl.Popup | null = null;
    /** One popup at a time: a new one replaces the old. */
    const show = (next: maplibregl.Popup) => {
      popup?.remove();
      popup = next;
    };
    const lookup = (kind: keyof MapData["lookups"], i: unknown) =>
      typeof i === "number" && i >= 0 ? data?.lookups[kind][i] : undefined;
    /** (Re-)adds the facility points; a style change wipes every source and layer. */
    const addFacilities = () => {
      if (!data) return;
      try {
        if (map.getSource("facilities")) return;
        map.addSource("facilities", { type: "geojson", data });
        map.addLayer({
          id: "facilities",
          type: "circle",
          source: "facilities",
          paint: {
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              5,
              2.5,
              10,
              5,
              14,
              8,
            ],
            "circle-color": [
              "match",
              ["get", "confidence"],
              "high",
              COLORS.high,
              "medium",
              COLORS.medium,
              "low",
              COLORS.low,
              COLORS.unchecked,
            ],
            "circle-stroke-width": 0.8,
            "circle-stroke-color": "#ffffff",
            "circle-opacity": 0.9,
          },
        });
      } catch {
        // The style is not ready yet (map.getSource throws until it is); the next "styledata" event retries.
      }
    };
    // Don't wait for the map's "load" (it fires only after every visible base-map tile has downloaded).
    map.on("styledata", addFacilities);
    download
      .then((d) => {
        data = d;
        setCount(d.features.length);
        addFacilities();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

    /** Card with the facility name, ward, council and region (plus the location details when `full`). */
    const card = (p: Record<string, string>, full: boolean) => {
      const el = document.createElement("div");
      el.style.fontSize = "13px";
      const title = document.createElement(full ? "a" : "div");
      if (title instanceof HTMLAnchorElement) title.href = `/facility/${encodeURIComponent(p.code)}`;
      title.textContent = p.name;
      title.style.fontWeight = "600";
      title.style.color = "#0f6e5b";
      el.append(title);
      for (const [label, value] of [
        ["Village", lookup("villages", p.v)],
        ["Ward", lookup("wards", p.w)],
        ["Council", lookup("councils", p.cn)],
        ["Region", lookup("regions", p.r)],
      ] as const) {
        const row = document.createElement("div");
        row.textContent = `${label}: ${value || "—"}`;
        el.append(row);
      }
      if (full) {
        const meta = document.createElement("div");
        meta.textContent = `${p.code} · ${lookup("types", p.t) ?? ""} · ${p.confidence} confidence · location from ${lookup("sources", p.s) ?? "hfr"}`;
        meta.style.color = "#5b6573";
        meta.style.marginTop = "4px";
        el.append(meta);
      }
      return el;
    };
    // Hover a point: a small card with its name, ward, council and region. It follows the pointer and never blocks it.
    const hover = new maplibregl.Popup({ offset: 10, closeButton: false, closeOnClick: false, maxWidth: "300px", className: "facility-hover" });
    map.on("mousemove", "facilities", (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      map.getCanvas().style.cursor = "pointer";
      hover.setLngLat(f.geometry.coordinates as [number, number]).setDOMContent(card(f.properties as Record<string, string>, false)).addTo(map);
    });
    map.on("mouseleave", "facilities", () => {
      map.getCanvas().style.cursor = "";
      hover.remove();
    });
    // Click (or tap, where there is no hover) a point: the same details plus a link to the facility page.
    map.on("click", "facilities", (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      hover.remove();
      show(
        new maplibregl.Popup({ offset: 8, maxWidth: "300px" })
          .setLngLat(f.geometry.coordinates as [number, number])
          .setDOMContent(card(f.properties as Record<string, string>, true))
          .addTo(map),
      );
    });
    return () => map.remove();
  }, [query]);

  // Switching base map keeps the view; the points are re-added when the new style has loaded.
  useEffect(() => {
    basemapRef.current = basemap;
    if (appliedRef.current === basemap) return;
    appliedRef.current = basemap;
    mapRef.current?.setStyle(BASEMAPS[basemap].style);
  }, [basemap]);

  return (
    <div className="relative">
      <div
        ref={ref}
        className="h-[70vh] w-full overflow-hidden rounded-lg border border-line"
      />
      <div
        className="absolute left-3 top-3 flex overflow-hidden rounded-md border border-line bg-white/95 text-xs shadow"
        role="radiogroup"
        aria-label="Base map"
      >
        {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={basemap === k}
            onClick={() => setBasemap(k)}
            className={`px-3 py-1.5 font-medium ${basemap === k ? "bg-brand text-white" : "text-ink hover:bg-canvas"}`}
          >
            {BASEMAPS[k].label}
          </button>
        ))}
      </div>
      <div className="absolute bottom-3 left-3 rounded-md bg-white/95 px-3 py-2 text-xs shadow">
        <div className="mb-1 font-semibold">
          {count == null ? "Loading…" : `${count.toLocaleString()} facilities`}
        </div>
        {Object.entries(COLORS).map(([k, c]) => (
          <div key={k} className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: c }}
            />
            {k}
          </div>
        ))}
        {error && <div className="mt-1 text-low">{error}</div>}
      </div>
    </div>
  );
}
