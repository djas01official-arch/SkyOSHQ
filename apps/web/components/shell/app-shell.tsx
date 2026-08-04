'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { cn } from '@/lib/cn';

import { ThemeToggle } from './theme-toggle';

type AppShellProps = Readonly<{
  children: ReactNode;
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
        'flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'bg-accent-soft text-accent'
          : 'text-muted-foreground hover:bg-surface-raised hover:text-foreground',
      )}
      href={item.href}
      onClick={onNavigate}
    >
      <Icon className="size-4" name={item.icon} />
      {item.label}
    </Link>
  );
}

export function AppShell({ children, onSignOut }: AppShellProps) {
  const pathname = usePathname();
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [isUtilityOpen, setIsUtilityOpen] = useState(false);

  function closeNavigation() {
    setIsNavigationOpen(false);
  }

  if (pathname === '/login') {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur lg:px-6">
        <div className="flex items-center gap-3">
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
          <Link
            className="flex items-center gap-2.5 font-semibold tracking-tight text-foreground"
            href="/dashboard"
          >
            <span className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-foreground">
              S
            </span>
            <span>SkyOS</span>
          </Link>
          <span className="hidden items-center gap-1 rounded-control border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted-foreground sm:flex">
            Acme Operations
            <Icon className="size-3" name="chevronDown" />
          </span>
        </div>

        <div className="flex items-center gap-1">
          <span className="hidden items-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-sm text-muted-foreground md:flex">
            <Icon className="size-4" name="search" />
            Search SkyOS
            <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px]">⌘K</kbd>
          </span>
          <ThemeToggle />
          <Button
            aria-expanded={isUtilityOpen}
            aria-label="Toggle utility panel"
            onClick={() => setIsUtilityOpen((currentValue) => !currentValue)}
            size="icon"
            variant="ghost"
          >
            <Icon className="size-4" name="panelRight" />
          </Button>
          <form action={onSignOut}>
            <Button
              aria-label="Sign out"
              className="ml-1"
              size="icon"
              type="submit"
              variant="ghost"
            >
              <Icon className="size-4" name="close" />
            </Button>
          </form>
        </div>
      </header>

      {isNavigationOpen ? (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-foreground/20 lg:hidden"
          onClick={closeNavigation}
          type="button"
        />
      ) : null}

      <aside
        className={cn(
          'fixed bottom-0 left-0 top-16 z-40 flex w-64 -translate-x-full flex-col border-r border-border bg-surface px-3 py-5 transition-transform lg:translate-x-0',
          isNavigationOpen && 'translate-x-0',
        )}
      >
        <nav aria-label="Primary navigation" className="space-y-1">
          <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Workspace
          </p>
          {workspaceNavigation.map((item) => (
            <NavigationLink
              isActive={pathname === item.href || (item.href === '/dashboard' && pathname === '/')}
              item={item}
              key={item.href}
              onNavigate={closeNavigation}
            />
          ))}
        </nav>
        <nav aria-label="System navigation" className="mt-7 space-y-1 border-t border-border pt-5">
          <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            System
          </p>
          {systemNavigation.map((item) => (
            <NavigationLink
              isActive={pathname === item.href}
              item={item}
              key={item.href}
              onNavigate={closeNavigation}
            />
          ))}
        </nav>
        <div className="mt-auto rounded-card border border-border bg-surface-raised p-3">
          <p className="text-xs font-semibold text-foreground">Platform foundation</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Core services connect here in later milestones.
          </p>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col pt-16 lg:pl-64">
        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
        <footer className="border-t border-border px-4 py-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-2 sm:flex-row">
            <span>© 2026 SkyOS. Foundation environment.</span>
            <span>All systems are currently in preview.</span>
          </div>
        </footer>
      </div>

      {isUtilityOpen ? (
        <>
          <button
            aria-label="Close utility panel"
            className="fixed inset-0 z-40 bg-foreground/20"
            onClick={() => setIsUtilityOpen(false)}
            type="button"
          />
          <aside
            aria-label="Utility panel"
            className="fixed bottom-0 right-0 top-16 z-50 w-full max-w-sm border-l border-border bg-surface p-5 shadow-panel sm:w-96"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-foreground">Utility panel</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Workspace context and shortcuts.
                </p>
              </div>
              <Button
                aria-label="Close utility panel"
                onClick={() => setIsUtilityOpen(false)}
                size="icon"
                variant="ghost"
              >
                <Icon className="size-4" name="close" />
              </Button>
            </div>
            <div className="mt-6 space-y-3">
              <div className="rounded-card border border-border bg-surface-raised p-4">
                <p className="text-sm font-medium text-foreground">Environment</p>
                <p className="mt-1 text-sm text-muted-foreground">Foundation workspace</p>
              </div>
              <div className="rounded-card border border-border bg-surface-raised p-4">
                <p className="text-sm font-medium text-foreground">Next milestone</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Connect domain services when they are available.
                </p>
              </div>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
