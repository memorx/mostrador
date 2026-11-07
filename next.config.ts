import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A demo, not a public site: keep it out of search engines.
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;
