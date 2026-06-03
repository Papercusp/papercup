/**
 * Coverage for visual-effects: the mode guard, getEffectiveVisualEffects
 * (minimal | system+prefers-reduced-motion → minimal, else full), and the
 * read/apply/write trio against stubbed window/document. React hooks are out
 * of scope (render-time).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isVisualEffectsMode,
  getEffectiveVisualEffects,
  readVisualEffectsMode,
  applyVisualEffectsMode,
  writeVisualEffectsMode,
} from './visual-effects';

const KEY = 'pc:ws:default:papercusp.visualEffectsMode';

function stub({ reduced = false, stored = null }: { reduced?: boolean; stored?: string | null } = {}) {
  const store = new Map<string, string>();
  if (stored !== null) store.set(KEY, stored);
  const dispatchEvent = vi.fn();
  const win = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    matchMedia: (q: string) => ({ matches: reduced && q.includes('reduce') }),
    dispatchEvent,
    location: { href: 'http://127.0.0.1:3070/' },
  };
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response));
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'CustomEvent',
    class {
      type: string;
      detail: unknown;
      constructor(t: string, init?: { detail?: unknown }) {
        this.type = t;
        this.detail = init?.detail;
      }
    },
  );
  return { store, doc, dispatchEvent, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe('isVisualEffectsMode', () => {
  it('accepts the three modes, rejects anything else', () => {
    expect(isVisualEffectsMode('system')).toBe(true);
    expect(isVisualEffectsMode('full')).toBe(true);
    expect(isVisualEffectsMode('minimal')).toBe(true);
    expect(isVisualEffectsMode('x')).toBe(false);
    expect(isVisualEffectsMode(null)).toBe(false);
    expect(isVisualEffectsMode(3)).toBe(false);
  });
});

describe('getEffectiveVisualEffects', () => {
  it('minimal stays minimal; full stays full', () => {
    expect(getEffectiveVisualEffects('minimal')).toBe('minimal');
    expect(getEffectiveVisualEffects('full')).toBe('full');
  });
  it("system → 'full' with no reduced-motion preference", () => {
    stub({ reduced: false });
    expect(getEffectiveVisualEffects('system')).toBe('full');
  });
  it("system → 'minimal' when prefers-reduced-motion matches", () => {
    stub({ reduced: true });
    expect(getEffectiveVisualEffects('system')).toBe('minimal');
  });
  it("system → 'full' under SSR (no window)", () => {
    expect(getEffectiveVisualEffects('system')).toBe('full');
  });
});

describe('readVisualEffectsMode', () => {
  it("defaults to 'system' under SSR", () => {
    expect(readVisualEffectsMode()).toBe('system');
  });
  it('reads a valid stored mode', () => {
    stub({ stored: 'minimal' });
    expect(readVisualEffectsMode()).toBe('minimal');
  });
  it("falls back to 'system' for a garbage stored value", () => {
    stub({ stored: 'garbage' });
    expect(readVisualEffectsMode()).toBe('system');
  });
});

describe('applyVisualEffectsMode', () => {
  it('writes both dataset attributes (effective + raw mode)', () => {
    const { doc } = stub({ reduced: false });
    applyVisualEffectsMode('minimal');
    expect(doc.documentElement.dataset.visualEffects).toBe('minimal');
    expect(doc.documentElement.dataset.visualEffectsMode).toBe('minimal');
    applyVisualEffectsMode('system');
    expect(doc.documentElement.dataset.visualEffects).toBe('full'); // no reduced-motion
    expect(doc.documentElement.dataset.visualEffectsMode).toBe('system');
  });
});

describe('writeVisualEffectsMode', () => {
  it('persists to localStorage, applies, and dispatches a change event', () => {
    const { store, doc, dispatchEvent } = stub();
    writeVisualEffectsMode('minimal');
    expect(store.get(KEY)).toBe('minimal');
    expect(doc.documentElement.dataset.visualEffects).toBe('minimal');
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  it('coerces an invalid mode to system before persisting', () => {
    const { store } = stub();
    writeVisualEffectsMode('bogus' as never);
    expect(store.get(KEY)).toBe('system');
  });

  it('persists the mode to PG via POST /api/profile (source of truth)', () => {
    const { fetchMock } = stub();
    writeVisualEffectsMode('minimal');
    const post = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
    );
    expect(post?.[0]).toBe('/api/profile');
    expect(JSON.parse((post?.[1] as { body: string }).body)).toEqual({ visual_effects_mode: 'minimal' });
  });
});
