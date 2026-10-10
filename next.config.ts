import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // An account export is sent to a server action as text; the default limit of
  // one megabyte is below a year of bank transactions.
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  transpilePackages: [
    "@marlinjai/data-table-core",
    "@marlinjai/data-table-react",
    "@marlinjai/data-table-adapter-prisma",
  ],
};

export default nextConfig;
