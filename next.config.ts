import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: [
    "@marlinjai/data-table-core",
    "@marlinjai/data-table-react",
    "@marlinjai/data-table-adapter-prisma",
  ],
};

export default nextConfig;
