import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.mock('./operator-state-pg', () => ({
  readOperatorState: async <T>(table: string) => (store.get(table) as T) ?? null,
  writeOperatorState: async (table: string, payload: unknown) => {
    store.set(table, payload);
  },
}));

import {
  isScannerResumeEnabled,
  getOrCreateScannerSessionId,
  bumpScannerSession,
  resetScannerSession,
} from './operator-scanner-session';

beforeEach(() => store.clear());
afterEach(() => store.clear());

describe('isScannerResumeEnabled', () => {
  it('false when env var unset', () => {
    delete process.env.OPERATOR_SCANNER_RESUME;
    expect(isScannerResumeEnabled()).toBe(false);
  });

  it('true when env var = "1"', () => {
    process.env.OPERATOR_SCANNER_RESUME = '1';
    expect(isScannerResumeEnabled()).toBe(true);
    delete process.env.OPERATOR_SCANNER_RESUME;
  });

  it('false when env var is something other than "1"', () => {
    process.env.OPERATOR_SCANNER_RESUME = 'true';
    expect(isScannerResumeEnabled()).toBe(false);
    delete process.env.OPERATOR_SCANNER_RESUME;
  });
});

describe('getOrCreateScannerSessionId', () => {
  it('returns a fresh UUID when no session exists', async () => {
    const id = await getOrCreateScannerSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('returns the same id on subsequent calls', async () => {
    const a = await getOrCreateScannerSessionId();
    const b = await getOrCreateScannerSessionId();
    expect(b).toBe(a);
  });

  it('persists the new session row with scanCount=0', async () => {
    const id = await getOrCreateScannerSessionId();
    const stored = store.get('operator_scanner_session') as { agentSessionId: string; scanCount: number };
    expect(stored.agentSessionId).toBe(id);
    expect(stored.scanCount).toBe(0);
  });

  it('regenerates if the stored id is malformed', async () => {
    store.set('operator_scanner_session', { agentSessionId: 'NOT_A_UUID', scanCount: 5 });
    const id = await getOrCreateScannerSessionId();
    expect(id).not.toBe('NOT_A_UUID');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('bumpScannerSession', () => {
  it('increments scanCount + refreshes lastUsedAt', async () => {
    await getOrCreateScannerSessionId();
    await bumpScannerSession();
    await bumpScannerSession();
    const stored = store.get('operator_scanner_session') as { scanCount: number };
    expect(stored.scanCount).toBe(2);
  });

  it('is a no-op when no session exists', async () => {
    await bumpScannerSession();
    expect(store.has('operator_scanner_session')).toBe(false);
  });
});

describe('resetScannerSession', () => {
  it('replaces the session id and zeroes scanCount', async () => {
    const a = await getOrCreateScannerSessionId();
    await bumpScannerSession();
    await resetScannerSession();
    const stored = store.get('operator_scanner_session') as { agentSessionId: string; scanCount: number };
    expect(stored.agentSessionId).not.toBe(a);
    expect(stored.scanCount).toBe(0);
  });
});
