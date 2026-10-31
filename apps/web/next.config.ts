import type { NextConfig } from 'next';

const config: NextConfig = {
  // Exportação estática: o mesmo build roda na Vercel e dentro do app Windows (Tauri).
  output: 'export',
  images: { unoptimized: true },
  transpilePackages: ['@jarvis/contracts'],
  reactStrictMode: true,
  poweredByHeader: false,
};
export default config;
