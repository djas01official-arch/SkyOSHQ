'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

const storageKey = 'skyos-theme';

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggleTheme() {
    setIsDark((currentValue) => {
      const nextValue = !currentValue;
      document.documentElement.classList.toggle('dark', nextValue);
      localStorage.setItem(storageKey, nextValue ? 'dark' : 'light');
      return nextValue;
    });
  }

  return (
    <Button
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={toggleTheme}
      size="icon"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      variant="ghost"
    >
      <Icon className="size-4" name={isDark ? 'sun' : 'moon'} />
    </Button>
  );
}
