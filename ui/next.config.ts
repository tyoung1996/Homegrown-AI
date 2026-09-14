import type { NextConfig } from 'next';

// the ui proxies /api/* to the nest api so the whole app lives on one port —
// that's what lets it sit behind tailscale funnel or any reverse proxy as-is
const API = process.env.API_URL ?? 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};

export default nextConfig;
