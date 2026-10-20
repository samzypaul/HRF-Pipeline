"use client";

import dynamic from "next/dynamic";

// MapLibre needs the browser (WebGL), so it is never rendered on the server.
const FacilityMap = dynamic(() => import("@/components/FacilityMap"), {
  ssr: false,
  loading: () => <div className="h-[calc(100vh-15rem)] min-h-[460px] w-full animate-pulse rounded-xl border border-line bg-panel" />,
});

export default function MapClient({ query }: { query: string }) {
  return <FacilityMap query={query} />;
}
