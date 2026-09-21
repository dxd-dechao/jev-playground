import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The playground is fixture-only in JEV-01: there is no route handler, no
  // outbound model call, and no API credential anywhere in the app.
  reactStrictMode: true,
};

export default nextConfig;
