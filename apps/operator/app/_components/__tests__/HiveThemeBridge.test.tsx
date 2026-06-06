// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FLAGS, type FlagPayload, resolveWithDefaults } from '@papercusp/flags';
import { setFlagPayload } from '@papercusp/flags/client';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';

import { HiveThemeBridge } from '../HiveThemeBridge';
import { THEME_STORAGE_KEY } from '@/lib/theme';

function setHive(on: boolean): void {
  const payload: FlagPayload = {
    flags: resolveWithDefaults({ [FLAGS.THE_HIVE]: on }),
    evaluatedAt: 1,
    source: 'override',
  };
  act(() => setFlagPayload(payload));
}

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
  });
  document.documentElement.removeAttribute('data-theme');
  document.head.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove());
  document.title = 'Papercusp Operator';
  window.localStorage.removeItem(wsLocalKey(THEME_STORAGE_KEY));
  setHive(false);
});

afterEach(() => {
  cleanup();
  setHive(false);
});

describe('HiveThemeBridge', () => {
  it('forces the Hive theme title and favicon while the-hive is enabled', () => {
    setHive(true);
    render(<HiveThemeBridge />);

    expect(document.documentElement.dataset.theme).toBe('hive');
    expect(document.title).toBe('Papercusp · The Hive');
    const favicon = document.getElementById('pc-hive-favicon') as HTMLLinkElement | null;
    expect(favicon?.href.endsWith('/brand/the-hive/favicon.svg')).toBe(true);
  });

  it('restores the saved classic theme when the flag turns off', () => {
    window.localStorage.setItem(wsLocalKey(THEME_STORAGE_KEY), 'black');
    setHive(true);
    render(<HiveThemeBridge />);
    expect(document.documentElement.dataset.theme).toBe('hive');

    setHive(false);

    expect(document.documentElement.dataset.theme).toBe('black');
    expect(document.title).toBe('Papercusp Operator');
    expect(document.getElementById('pc-hive-favicon')).toBeNull();
  });
});
