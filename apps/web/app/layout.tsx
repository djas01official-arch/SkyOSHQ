import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '@fontsource-variable/sora';

import { AppShell } from '@/components/shell/app-shell';
import { getCurrentOrganizationContext } from '@/lib/organization-context';

import { logoutAction } from './logout-action';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'SkyOS',
    template: '%s · SkyOS',
  },
  description: 'SkyOS enterprise operating platform. Your system. Your sky.',
};

// The shell resolves session and tenancy state from server-only runtime
// dependencies. It must not be evaluated as static build-time page data.
export const dynamic = 'force-dynamic';

const themeScript = `
  try {
    const savedTheme = localStorage.getItem('skyos-theme');
    document.documentElement.classList.toggle('dark', savedTheme !== 'light');
  } catch {}
`;

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default async function RootLayout({ children }: RootLayoutProps) {
  const context = await getCurrentOrganizationContext();

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} id="skyos-theme" />
        <AppShell context={context} onSignOut={logoutAction}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
