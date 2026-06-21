/**
 * liveness-window-source.test.ts — the D-006 single-source guard for the 10-min liveness window
 * (live-configurability-audit-2026-06-20 P-014, consolidate step).
 *
 * The window was ≥4 deliberately-equal literals (their own comments cross-reference each other):
 * STALE_MS (liveness.ts, the dep-free canonical), STALE_CLAIM_GRACE_MS (work-items-stale-claims),
 * IDLE_SESSION_GRACE_MS (idle-session-reaper), PRESENCE_STALE_MS (claim-discipline-action). They now
 * all derive from STALE_MS. This asserts no surviving re-declaration so a future window change (or the
 * coming coord:*_config overrides) can't desync a forgotten copy.
 *
 * Run: cd packages/operator-core && npx vitest run lib/liveness-window-source.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STALE_MS } from './liveness';

const lib = dirname(fileURLToPath(import.meta.url));
const FILES = [
  'work-items-stale-claims.ts',
  'idle-session-reaper.ts',
  'harness/routines/claim-discipline-action.ts',
];
// A literal numeric re-declaration of any liveness-window const (the desync footgun).
const LITERAL = /(STALE_CLAIM_GRACE_MS|IDLE_SESSION_GRACE_MS|PRESENCE_STALE_MS)\s*=\s*\d/;

describe('liveness window — single source (P-014 / D-006)', () => {
  it('STALE_MS is the canonical 10-min window', () => {
    expect(STALE_MS).toBe(600_000);
  });

  it('no liveness-window const re-declares the literal — all derive from STALE_MS', () => {
    const offenders = FILES.filter((f) => LITERAL.test(readFileSync(join(lib, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('each consumer references the canonical STALE_MS', () => {
    for (const f of FILES) {
      expect(readFileSync(join(lib, f), 'utf8')).toMatch(/\bSTALE_MS\b/);
    }
  });
});
