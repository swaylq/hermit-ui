import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's custom-output client (src/generated/prisma) must not be bundled by
  // Turbopack/SWC — otherwise the runtime engine lookup loses the path to
  // libquery_engine-*.node and 500s in production with "Prisma Client could
  // not locate the Query Engine for runtime <platform>". See pris.ly/d/engine-not-found-nextjs.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "@prisma/engines"],
};

export default nextConfig;
