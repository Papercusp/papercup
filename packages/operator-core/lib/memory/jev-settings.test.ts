/**
 * jev-settings.test.ts — P-013 / D-008 of jev-decision-model-integration-2026-09-29.
 *
 * Pins the one rule every memory-injection consumer depends on: Jev is
 * EFFECTIVELY off unless the user chose shadow/on AND a key is stored, and
 * "off" means zero network calls. Also pins that the raw key never leaves the
 * store through the view, and that unreadable state falls back to today's system.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  failReads: false,
  reads: 0,
  writes: [] as Array<{ key: string; value: string; workspace: string }>,
}));
const creds = vi.hoisted(() => ({ store: {} as Record<string, string> }));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('SELECT value')) {
        db.reads += 1;
        if (db.failReads) return Promise.reject(new Error('pg down'));
        const v = db.rows.get(values[0] as string);
        return Promise.resolve(v === undefined ? [] : [{ value: v }]);
      }
      if (text.includes('INSERT INTO harness_shared.operator_settings')) {
        const [key, value, , workspace] = values as [string, string, number, string];
        db.rows.set(key, value);
        db.writes.push({ key, value, workspace });
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected SQL: ${text}`));
    },
  }),
}));

vi.mock('../integration-credentials', () => ({
  readIntegrationKey: async (name: string) => creds.store[name],
  writeIntegrationCredentials: async (partial: Record<string, string | null>) => {
    for (const [k, v] of Object.entries(partial)) {
      if (v === null) delete creds.store[k];
      else creds.store[k] = v;
    }
    return creds.store;
  },
  maskIntegrationKey: (v: string | null | undefined) => (v && v.length >= 8 ? `${v.slice(0, 3)}...${v.slice(-4)}` : null),
}));

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import { configureDecisionModel, decide } from '@papercusp/decision-model';
import {
  __resetJevSettingsCacheForTest,
  ensureJevDecisionClient,
  getJevMode,
  getJevSettingsView,
  JEV_API_KEY_NAME,
  jevModeKey,
  resolveJevMemoryInjection,
  setJevApiKey,
  setJevMode,
} from './jev-settings';

// Deliberately low-entropy: an obvious fixture, never mistakable for a real key.
const KEY = 'fake-jev-key-aaaaaaaa';

beforeEach(() => {
  db.rows.clear();
  db.failReads = false;
  db.reads = 0;
  db.writes = [];
  creds.store = {};
  __resetJevSettingsCacheForTest();
  configureDecisionModel(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureDecisionModel(null);
});

describe('mode store', () => {
  it('defaults to off when nothing is stored', async () => {
    expect(await getJevMode()).toBe('off');
  });

  it('round-trips a mode under the per-workspace key', async () => {
    await setJevMode('shadow');
    expect(db.writes).toEqual([{ key: jevModeKey('ws-test'), value: 'shadow', workspace: 'ws-test' }]);
    __resetJevSettingsCacheForTest();
    expect(await getJevMode()).toBe('shadow');
  });

  it('keeps workspaces independent', async () => {
    await setJevMode('on', 'ws-a');
    __resetJevSettingsCacheForTest();
    expect(await getJevMode('ws-a')).toBe('on');
    expect(await getJevMode('ws-b')).toBe('off');
  });

  it('an unrecognised stored value reads as off', async () => {
    db.rows.set(jevModeKey('ws-test'), 'maybe');
    expect(await getJevMode()).toBe('off');
  });

  it('a read failure reads as off (today’s system), not as a throw', async () => {
    db.rows.set(jevModeKey('ws-test'), 'on');
    db.failReads = true;
    expect(await getJevMode()).toBe('off');
  });

  it('caches reads briefly, and a write refreshes the cache at once', async () => {
    await getJevMode();
    await getJevMode();
    expect(db.reads).toBe(1);
    await setJevMode('on');
    expect(await getJevMode()).toBe('on');
    expect(db.reads).toBe(1);
  });

  it('rejects an invalid mode', async () => {
    await expect(setJevMode('always' as never)).rejects.toThrow(/invalid Jev mode/);
  });
});

describe('the effective-mode gate', () => {
  it.each([
    ['off', true, 'off'],
    ['off', false, 'off'],
    ['shadow', false, 'off'],
    ['on', false, 'off'],
    ['shadow', true, 'shadow'],
    ['on', true, 'on'],
  ] as const)('mode %s with key=%s ⇒ effective %s', async (mode, withKey, effective) => {
    if (mode !== 'off') await setJevMode(mode);
    if (withKey) await setJevApiKey(KEY);
    const r = await resolveJevMemoryInjection();
    expect(r).toEqual({ mode, keyPresent: withKey, effective });
  });
});

describe('key store', () => {
  it('saves the key trimmed under TYPESAFE_API_KEY and clears it with null', async () => {
    await setJevApiKey(`  ${KEY}\n`);
    expect(creds.store[JEV_API_KEY_NAME]).toBe(KEY);
    await setJevApiKey(null);
    expect(creds.store).not.toHaveProperty(JEV_API_KEY_NAME);
  });

  it.each([['short'], ['has a space in it'], ['x'.repeat(5000)]])('rejects an implausible key %#', async (bad) => {
    await expect(setJevApiKey(bad)).rejects.toThrow();
    expect(creds.store).not.toHaveProperty(JEV_API_KEY_NAME);
  });

  it('the view masks the key and never carries it raw', async () => {
    await setJevApiKey(KEY);
    await setJevMode('shadow');
    const view = await getJevSettingsView();
    expect(view).toEqual({ mode: 'shadow', keyPresent: true, maskedKey: 'fak...aaaa', effective: 'shadow', model: 'jev-1.13.0' });
    expect(JSON.stringify(view)).not.toContain(KEY);
  });
});

describe('the decision client', () => {
  it('with no key stored, a decision is inconclusive(no-key) and makes ZERO network calls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    ensureJevDecisionClient();
    const out = await decide({ state: 'turn text', questions: { q: { type: 'yesNo', instructions: 'Relevant?' } } });
    expect(out).toMatchObject({ kind: 'inconclusive', reason: 'no-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the key per call, so a key saved after install is used without a restart', async () => {
    const fetchSpy = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    ensureJevDecisionClient();
    await setJevApiKey(KEY);
    const out = await decide({ state: 'turn text', questions: { q: { type: 'yesNo', instructions: 'Relevant?' } } });
    expect(out).toMatchObject({ kind: 'answered', answers: { q: { pYes: 0.9 } } });
    const init = (fetchSpy.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1];
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('installs one process-wide client', () => {
    expect(ensureJevDecisionClient()).toBe(ensureJevDecisionClient());
  });
});
