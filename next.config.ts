import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  transpilePackages: [
    "@marlinjai/data-table-core",
    "@marlinjai/data-table-react",
    "@marlinjai/data-table-adapter-memory",
    "@marlinjai/data-table-adapter-d1",
  ],
};

export default nextConfig;
