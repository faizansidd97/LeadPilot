import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import {browserSecurityHeaders} from '../backend/src/server/security.ts';
const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const config: NextConfig = {
  poweredByHeader:false,
  async headers(){return [{source:'/:path*',headers:Object.entries(browserSecurityHeaders({development:process.env.NODE_ENV==='development',https:process.env.APP_URL?.startsWith('https://')===true})).map(([key,value])=>({key,value}))}];},
  transpilePackages: ['@leadpilot/backend'],
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
};
export default config;
