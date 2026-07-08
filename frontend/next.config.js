/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  images: {
    // TMDB serves all poster art from this host; allow next/image to optimize it.
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org", pathname: "/t/p/**" },
    ],
  },
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000",
  },
  experimental: {
    // Cap build parallelism to one worker. The post-compile phases (page-data
    // collection, static generation) spawn one worker per CPU by default, and
    // the combined memory reservation OOMs on memory-constrained machines —
    // both this dev box and the 4 GB production VPS. Slower build, bounded peak.
    cpus: 1,
  },
};

module.exports = nextConfig;
