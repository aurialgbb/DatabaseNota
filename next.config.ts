import { withWorkflow } from 'workflow/next';
import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() { return [{ source: '/', destination: '/portal.html' }]; },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'X-Frame-Options', value: 'DENY' }
    ] }, { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] }];
  }
};
export default withWorkflow(config);
