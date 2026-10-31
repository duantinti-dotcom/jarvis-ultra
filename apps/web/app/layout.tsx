import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'JARVIS ULTRA',
  description: 'Assistente pessoal de IA local com controle autorizado do computador.',
  icons: { icon: '/icon.svg' },
  manifest: '/manifest.webmanifest',
};
export const viewport: Viewport = { themeColor: '#06080c', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="neural-bg h-dvh">{children}</body>
    </html>
  );
}
