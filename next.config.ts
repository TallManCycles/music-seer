import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon: keep it external so Next does not try to
  // bundle the .node binary.
  serverExternalPackages: ["better-sqlite3"],
  output: "standalone",
};

export default nextConfig;
