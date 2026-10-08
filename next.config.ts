import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node-postgres must not be bundled into server code.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default nextConfig;
