import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@marlinjai/data-table-core",
    "@marlinjai/data-table-react",
    "@marlinjai/data-table-adapter-memory",
  ],
};

export default nextConfig;
