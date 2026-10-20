import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node-postgres and exceljs must not be bundled into server code.
  serverExternalPackages: ["pg", "exceljs"],
  poweredByHeader: false,
};

export default nextConfig;
