/**
 * Tests for the operator's host wiring of the desktop-ipc `forceHttp` seam.
 *
 * Why this file exists (EI-19420043903144442): configuring the seam AT ALL makes
 * `cfg.forceHttp` defined, which means the generic lib's own fallback is never
 * consulted. So this resolver is the single point of failure for the documented
 * rollback lever — and it read only `process.env.NEXT_PUBLIC_*`, which a Vite
 * build substitutes with the literal `{}`. The lever was dead in the shipped
 * desktop app while every unit test of the generic lib stayed green, because
 * those tests run in Node where `process.env` is real.
 *
 * Run with: npm run test:file -- packages/operator-core/lib/transport-adapters/configure.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FORCE_HTTP_ENV_NAME,
  FORCE_HTTP_STORAGE_KEY,
  readForceHttpLever,
} from './configure';

type Bag = Record<string, string | undefined>;

const ENV_KEYS = [FORCE_HTTP_ENV_NAME, `NEXT_PUBLIC_${FORCE_HTTP_ENV_NAME}`] as const;
let savedEnv: Record<string, string | undefined>;

function setBag(bag: Bag | undefined): void {
  (globalThis as { __DESKTOP_IPC_ENV__?: Bag }).__DESKTOP_IPC_ENV__ = bag;
}

/** Minimal localStorage stand-in — Node has none. */
function setStorage(entries: Record<string, string> | undefined): void {
  if (entries === undefined) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    return;
  }
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (k in entries ? entries[k] : null),
  };
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  setBag(undefined);
  setStorage(undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('readForceHttpLever', () => {
  it('is undefined when no source carries a value', () => {
    expect(readForceHttpLever()).toBeUndefined();
  });

  it('reads localStorage — the only source settable on a SHIPPED desktop build', () => {
    setStorage({ [FORCE_HTTP_STORAGE_KEY]: '1' });
    expect(readForceHttpLever()).toBe('1');
  });

  it('reads the runtime bag when localStorage is absent', () => {
    setBag({ [FORCE_HTTP_ENV_NAME]: 'true' });
    expect(readForceHttpLever()).toBe('true');
  });

  it('accepts the NEXT_PUBLIC_-prefixed name in the bag (back-compat)', () => {
    setBag({ [`NEXT_PUBLIC_${FORCE_HTTP_ENV_NAME}`]: '1' });
    expect(readForceHttpLever()).toBe('1');
  });

  it('reads process.env for Node-side consumers', () => {
    process.env[FORCE_HTTP_ENV_NAME] = '1';
    expect(readForceHttpLever()).toBe('1');
  });

  it('prefers localStorage over the bag and over process.env', () => {
    process.env[FORCE_HTTP_ENV_NAME] = '0';
    setBag({ [FORCE_HTTP_ENV_NAME]: '0' });
    setStorage({ [FORCE_HTTP_STORAGE_KEY]: '1' });
    expect(readForceHttpLever()).toBe('1');
  });

  it('resolves with process.env replaced by {} — the shipped-bundle condition', () => {
    const realProcess = globalThis.process;
    try {
      (globalThis as { process?: unknown }).process = { env: {} };
      setStorage({ [FORCE_HTTP_STORAGE_KEY]: '1' });
      expect(readForceHttpLever()).toBe('1');
    } finally {
      (globalThis as { process?: unknown }).process = realProcess;
    }
  });

  it('never throws when storage access is blocked — it must not break boot', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('SecurityError: storage is partitioned');
      },
    };
    expect(() => readForceHttpLever()).not.toThrow();
    expect(readForceHttpLever()).toBeUndefined();
  });

  it('falls through to a lower source when storage throws but env carries a value', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    };
    process.env[FORCE_HTTP_ENV_NAME] = '1';
    expect(readForceHttpLever()).toBe('1');
  });
});
