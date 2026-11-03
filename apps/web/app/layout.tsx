import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lume IA',
  description: 'Lume IA: converse, crie sites e apps com preview ao vivo e fale por voz.',
  icons: { icon: '/icon.svg' },
  manifest: '/manifest.webmanifest',
};
export const viewport: Viewport = { themeColor: '#050606', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="neural-bg h-dvh">{children}</body>
    </html>
  );
}
