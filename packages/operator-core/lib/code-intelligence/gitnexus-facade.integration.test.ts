/**
 * LIVE integration test for the GitNexus facade (P-006, leg (a): direct MCP
 * dispatch). This spawns the real `gitnexus mcp` child through the real bridge
 * and asserts the frozen contracts against real answers.
 *
 * ── Why this exists separately from the unit suite ────────────────────────
 * The unit suite pins behaviour against envelopes measured on 2026-08-21. That
 * proves the NORMALIZATION is right, but it cannot notice the backend changing
 * underneath us — a gitnexus upgrade that starts emitting one-indexed lines
 * would leave every unit test green while every citation silently moved by
 * one. This suite is the falsifier for that class.
 *
 * ── Two operational rails, both learned the hard way ──────────────────────
 * 1. TEARDOWN IS MANDATORY. getDynamicTools() spawns a child held on a 5-min
 *    unref'd idle timer whose stdio pipes are active handles, so the process
 *    NEVER exits on its own — a suite without `_resetChildrenForTests()` hangs
 *    with no failing assertion. (This is also what once faked a "30x
 *    enumeration regression": a probe piped through `tail`, which flushes only
 *    at EOF, on a process that never reached EOF.)
 * 2. SKIPS MUST BE LOUD. If gitnexus is not installed, this suite skips — but
 *    it prints why. A silent skip on a backend-verification suite is
 *    indistinguishable from a pass, which is the failure mode the whole
 *    code-intelligence plane exists to prevent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  configureGitnexusDispatch,
  gitnexusFacade,
  gitnexusOpForIntent,
  gitnexusRefusal,
} from './gitnexus-facade.ts';
import { isTrustworthyEmpty } from './contracts.ts';
import { ACCEPTANCE_CORPUS } from './acceptance-corpus.ts';

const require = createRequire(import.meta.url);

const BRIDGE_PATH = join(
  process.cwd().split('/packages/')[0],
  'libs/papercusp/plugins/gitnexus-bridge/index.cjs',
);
const PINNED_BIN = join(
  homedir(),
  '.papercusp/vendor/gitnexus/node_modules/.bin/gitnexus',
);

const AVAILABLE = existsSync(BRIDGE_PATH) && existsSync(PINNED_BIN);

if (!AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    `[gitnexus-facade.integration] SKIPPING — bridge=${existsSync(BRIDGE_PATH)} ` +
      `pinnedBin=${existsSync(PINNED_BIN)}. Install with: ` +
      `npm install --prefix ~/.papercusp/vendor/gitnexus gitnexus@1.6.9`,
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bridge: any = null;

describe.skipIf(!AVAILABLE)('gitnexus facade — live backend', () => {
  beforeAll(async () => {
    bridge = require(BRIDGE_PATH);
    const { handlers } = await bridge.getDynamicTools();
    configureGitnexusDispatch((tool, args) =>
      handlers[tool](args, { workspaceId: 'papercusp-workspace' }),
    );
  }, 60_000);

  afterAll(() => {
    // MANDATORY — see rail 1 in the module header.
    bridge?._resetChildrenForTests?.();
    configureGitnexusDispatch(null);
  });

  it(
    'resolves a known symbol to a ONE-indexed line that matches the real file',
    async () => {
      const a = await gitnexusFacade('symbol', {
        name: 'pinModuleState',
        kind: 'Function',
      });
      expect(a.error).toBeNull();
      expect(a.sites.length).toBeGreaterThan(0);

      const site = a.sites.find((s) => s.path.includes('module-singleton'));
      expect(site).toBeDefined();

      // The real falsifier: read the file and require the cited line to
      // actually contain the declaration. This is what catches a backend
      // line-base change, which no fixture can.
      const fs = await import('node:fs/promises');
      const root = process.cwd().split('/packages/')[0];
      const body = await fs.readFile(join(root, site!.path), 'utf8');
      const lines = body.split('\n');
      expect(site!.line1).not.toBeNull();
      expect(lines[site!.line1! - 1]).toContain('pinModuleState');
    },
    60_000,
  );

  it(
    'CONTROL: a nonsense symbol does NOT come back as a confident hit',
    async () => {
      // The single most important assertion in this file. GitNexus `query`
      // fails exactly here (D-021), which is why it is not routed; `context`
      // must not share the defect.
      const a = await gitnexusFacade('symbol', {
        name: 'zzz_no_such_symbol_control_zzz',
        kind: 'Function',
      });
      expect(a.sites).toEqual([]);
      // Either it is a healthy true-empty or it is loudly degraded/failed.
      // What it must never be is populated.
      expect(isTrustworthyEmpty(a)).toBe(true);
    },
    60_000,
  );

  it(
    'impact discriminates by direction and errors honestly on an unknown target',
    async () => {
      const down = await gitnexusFacade('impact', {
        name: 'managedSpawn',
        direction: 'downstream',
      });
      expect(down.error).toBeNull();
      expect(down.truncation.totalAvailable).toBeGreaterThan(0);

      const missing = await gitnexusFacade('impact', {
        name: 'zzz_no_such_symbol_control_zzz',
        direction: 'downstream',
      });
      // An unknown target must be an explicit error, never impactedCount: 0
      // presented as a real answer.
      expect(missing.error).toMatch(/not found/i);
      expect(isTrustworthyEmpty(missing)).toBe(true);
    },
    60_000,
  );

  it(
    'callers returns real call sites, each one-indexed',
    async () => {
      const a = await gitnexusFacade('callers', { name: 'pinModuleState' });
      expect(a.error).toBeNull();
      for (const s of a.sites) {
        expect(s.path).toBeTruthy();
        if (s.line1 !== null) expect(s.line1).toBeGreaterThanOrEqual(1);
      }
    },
    60_000,
  );

  it(
    'every gitnexus-eligible corpus case gets an answer or a reasoned refusal',
    async () => {
      const eligible = ACCEPTANCE_CORPUS.filter((c) =>
        c.eligibleBackends.includes('gitnexus'),
      );
      expect(eligible.length).toBeGreaterThan(0);

      const unresolved: string[] = [];
      for (const c of eligible) {
        const op = gitnexusOpForIntent(c.intent);
        if (op === null) {
          const refusal = gitnexusRefusal(c.intent, c.query);
          if (refusal === null) unresolved.push(`${c.id} (${c.intent})`);
          else expect(refusal.error).toMatch(/Use instead:/);
          continue;
        }
        const a = await gitnexusFacade(op, { name: c.query });
        // Whatever the outcome, it must be legible: never an empty answer that
        // claims health without saying anything.
        expect(isTrustworthyEmpty(a)).toBe(true);
      }
      expect(unresolved).toEqual([]);
    },
    180_000,
  );
});
