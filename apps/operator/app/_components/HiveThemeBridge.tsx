'use client';

import { useEffect } from 'react';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { applyTheme, readActiveTheme, subscribeTheme } from '@/lib/theme';

const HIVE_TITLE = 'Papercusp · The Hive';
const CLASSIC_TITLE = 'Papercusp Operator';
const HIVE_FAVICON_ID = 'pc-hive-favicon';
const HIVE_FAVICON_HREF = '/brand/the-hive/favicon.svg';

function setHiveFavicon(enabled: boolean): void {
  const existing = document.getElementById(HIVE_FAVICON_ID);
  if (!enabled) {
    existing?.remove();
    return;
  }

  const link = (existing ?? document.createElement('link')) as HTMLLinkElement;
  link.id = HIVE_FAVICON_ID;
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = HIVE_FAVICON_HREF;
  if (!existing) document.head.appendChild(link);
}

export function HiveThemeBridge() {
  const hiveEnabled = useFlag(FLAGS.THE_HIVE);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const apply = () => {
      if (hiveEnabled) {
        document.documentElement.dataset.theme = 'hive';
        document.title = HIVE_TITLE;
        setHiveFavicon(true);
        return;
      }
      applyTheme(readActiveTheme());
      document.title = CLASSIC_TITLE;
      setHiveFavicon(false);
    };

    apply();
    if (hiveEnabled) return undefined;
    return subscribeTheme(apply);
  }, [hiveEnabled]);

  return null;
}
