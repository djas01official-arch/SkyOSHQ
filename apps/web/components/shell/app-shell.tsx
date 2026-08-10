'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import type { OrganizationContext } from '../../../../database/context/organization-context';

import { Wordmark } from '@/components/brand/wordmark';
import { OrganizationSwitcher, WorkspaceSwitcher } from '@/components/shell/context-switcher';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Icon, type IconName } from '@/components/ui/icon';
import { StatusIndicator } from '@/components/ui/status-indicator';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

type AppShellProps = Readonly<{
  children: ReactNode;
  context: OrganizationContext | null;
  onSignOut: () => Promise<void>;
}>;

type NavigationItem = {
  href: string;
  icon: IconName;
  label: string;
};

const workspaceNavigation: NavigationItem[] = [
  { href: '/dashboard', icon: 'grid', label: 'Dashboard' },
  { href: '/ai', icon: 'sparkles', label: 'AI' },
  { href: '/knowledge', icon: 'book', label: 'Knowledge' },
  { href: '/tasks', icon: 'checkSquare', label: 'Tasks' },
];

const systemNavigation: NavigationItem[] = [
  { href: '/settings', icon: 'settings', label: 'Settings' },
];

type NavigationLinkProps = {
  isActive: boolean;
  item: NavigationItem;
  onNavigate: () => void;
};

function NavigationLink({ isActive, item, onNavigate }: NavigationLinkProps) {
  return (
    <Link
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'focus-ring group relative flex min-h-10 items-center gap-3 rounded-control border px-3 py-2 text-sm font-medium transition-[background-color,border-color,color]',
        isActive
          ? 'border-brand-bright/25 bg-accent-soft text-foreground'
          : 'border-transparent text-muted-foreground hover:border-border hover:bg-surface-raised hover:text-foreground',
      )}
      href={item.href}
      onClick={onNavigate}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand-cyan opacity-0 shadow-[0_0_10px_rgb(0_212_255_/_0.45)] transition-opacity',
          isActive && 'opacity-100',
        )}
      />
      <Icon
        className={cn(
          'size-[1.125rem] transition-colors',
          isActive ? 'text-brand-highlight' : 'text-muted-foreground group-hover:text-brand-bright',
        )}
        name={item.icon}
      />
      {item.label}
    </Link>
  );
}

function isNavigationItemActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/' || pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children, context, onSignOut }: AppShellProps) {
  const pathname = usePathname();
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [isUtilityOpen, setIsUtilityOpen] = useState(false);

  useEffect(() => {
    if (!isNavigationOpen && !isUtilityOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setIsNavigationOpen(false);
      setIsUtilityOpen(false);
    }

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isNavigationOpen, isUtilityOpen]);

  function closeNavigation() {
    setIsNavigationOpen(false);
  }

  if (pathname === '/login') return <>{children}</>;

  return (
    <div className="min-h-screen bg-background">
      <a
        className="focus-ring fixed left-4 top-3 z-[70] -translate-y-20 rounded-control bg-accent px-4 py-2 text-sm font-semibold text-white transition-transform focus:translate-y-0"
        href="#main-content"
      >
        Skip to content
      </a>

      <header className="fixed inset-x-0 top-0 z-40 flex h-[4.5rem] items-center justify-between border-b border-border bg-background/95 px-3 sm:px-5 lg:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Tooltip content="Open navigation">
            <Button
              aria-expanded={isNavigationOpen}
              aria-label="Toggle navigation"
              className="lg:hidden"
              onClick={() => setIsNavigationOpen((currentValue) => !currentValue)}
              size="icon"
              variant="ghost"
            >
              <Icon className="size-5" name={isNavigationOpen ? 'close' : 'menu'} />
            </Button>
          </Tooltip>
          <Link
            aria-label="SkyOS dashboard"
            className="focus-ring rounded-md px-1 py-1"
            href="/dashboard"
          >
            <Wordmark showTagline />
          </Link>
          <span aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
          <div className="hidden min-w-0 sm:block">
            <OrganizationSwitcher context={context} />
          </div>
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1">
          <StatusIndicator className="mr-2 hidden lg:inline-flex" tone="accent">
            Protected workspace
          </StatusIndicator>
          <ThemeToggle />
          <Tooltip content="Open utility panel">
            <Button
              aria-expanded={isUtilityOpen}
              aria-label="Toggle utility panel"
              onClick={() => setIsUtilityOpen((currentValue) => !currentValue)}
              size="icon"
              variant="ghost"
            >
              <Icon className="size-4" name="panelRight" />
            </Button>
          </Tooltip>
          <form action={onSignOut}>
            <Tooltip content="Sign out">
              <Button aria-label="Sign out" size="icon" type="submit" variant="ghost">
                <Icon className="size-4" name="logOut" />
              </Button>
            </Tooltip>
          </form>
        </div>
      </header>

      {isNavigationOpen ? (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-overlay lg:hidden"
          onClick={closeNavigation}
          type="button"
        />
      ) : null}

      <aside
        className={cn(
          'fixed bottom-0 left-0 top-[4.5rem] z-40 flex w-64 -translate-x-full flex-col border-r border-border bg-surface px-3 py-5 shadow-elevated transition-transform lg:translate-x-0 lg:shadow-none',
          isNavigationOpen && 'translate-x-0',
        )}
      >
        <div className="mb-4 px-2 sm:hidden">
          <OrganizationSwitcher context={context} />
        </div>
        <nav aria-label="Primary navigation" className="space-y-1">
          <p className="px-3 pb-2 text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Workspace
          </p>
          {workspaceNavigation.map((item) => (
            <NavigationLink
              isActive={isNavigationItemActive(pathname, item.href)}
              item={item}
              key={item.href}
              onNavigate={closeNavigation}
            />
          ))}
        </nav>
        <nav aria-label="System navigation" className="mt-7 space-y-1 border-t border-border pt-5">
          <p className="px-3 pb-2 text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            System
          </p>
          {systemNavigation.map((item) => (
            <NavigationLink
              isActive={isNavigationItemActive(pathname, item.href)}
              item={item}
              key={item.href}
              onNavigate={closeNavigation}
            />
          ))}
        </nav>
        <Card className="mt-auto p-3" variant="muted">
          <WorkspaceSwitcher context={context} />
        </Card>
      </aside>

      <div className="relative flex min-h-screen flex-col pt-[4.5rem] lg:pl-64">
        <div aria-hidden="true" className="shell-grid pointer-events-none absolute inset-0" />
        <main className="relative flex-1 p-4 sm:p-6 lg:p-8" id="main-content" tabIndex={-1}>
          {children}
        </main>
        <footer className="relative border-t border-border bg-background/80 px-4 py-5 text-xs text-muted-foreground sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <span>© 2026 SkyOS. Enterprise foundation.</span>
            <span className="font-semibold uppercase tracking-[0.16em]">
              Your system. <span className="text-brand-highlight">Your sky.</span>
            </span>
          </div>
        </footer>
      </div>

      <Dialog
        description="Organization, workspace, and effective access details."
        onOpenChange={setIsUtilityOpen}
        open={isUtilityOpen}
        placement="right"
        title="Current context"
      >
        <div className="space-y-3">
          <Card className="p-4" variant="muted">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-foreground">Organization</p>
              <Badge tone="accent">Active</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {context?.activeOrganization?.name ?? 'No active organization'}
            </p>
            {context?.activeOrganization ? (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {context.activeOrganization.slug} Â· {context.activeOrganization.role.toLowerCase()}
              </p>
            ) : null}
          </Card>
          <Card className="p-4" variant="muted">
            <p className="text-sm font-semibold text-foreground">Workspace</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {context?.activeWorkspace?.name ?? 'No workspace selected'}
            </p>
            {context?.activeWorkspace ? (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {context.activeWorkspace.slug} Â· {context.activeWorkspace.role?.toLowerCase()}
              </p>
            ) : null}
          </Card>
          <div className="rounded-control border border-brand-bright/20 bg-accent-soft px-4 py-3">
            <StatusIndicator tone="accent">Access is evaluated from active context</StatusIndicator>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
