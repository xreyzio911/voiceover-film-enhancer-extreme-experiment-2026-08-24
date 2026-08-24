/** @type {import('next').NextConfig} */
const extremeMlAllowedWorkerOrigins =
  process.env.NEXT_PUBLIC_EXTREME_ML_ALLOWED_WORKER_ORIGINS
  ?? process.env.EXTREME_ML_ALLOWED_WORKER_ORIGINS
  ?? "";

const nextConfig = {
  env: {
    NEXT_PUBLIC_EXTREME_ML_ALLOWED_WORKER_ORIGINS: extremeMlAllowedWorkerOrigins,
  },
  experimental: {
    proxyClientMaxBodySize: "2gb",
  },
  turbopack: {
    root: __dirname,
  },
};

module.exports = nextConfig;
