import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AppShell } from '@/components/shell/app-shell';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'SkyOS',
    template: '%s · SkyOS',
  },
  description: 'SkyOS enterprise operating platform',
};

const themeScript = `
  try {
    const savedTheme = localStorage.getItem('skyos-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', savedTheme ? savedTheme === 'dark' : prefersDark);
  } catch {}
`;

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} id="skyos-theme" />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
