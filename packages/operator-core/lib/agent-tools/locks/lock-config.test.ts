/**
 * lock-config.test.ts — the D-006 single-source guard for the lock TTL/wait defaults
 * (live-configurability-audit-2026-06-20 P-013).
 *
 * Asserts the canonical values + that NO other lock tool re-declares the TTL/wait literals — so a
 * runtime change (the coming locks:lock_config) can't desync a forgotten copy. A duplicated-literal
 * item is not "done" without this test (D-006).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/lock-config.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOCK_TTL_SEC, MAX_LOCK_TTL_SEC, MAX_LOCK_WAIT_SEC } from './lock-config';

const dir = dirname(fileURLToPath(import.meta.url));

describe('lock-config — single source (P-013 / D-006)', () => {
  it('exposes the canonical lock TTL / wait defaults', () => {
    expect(DEFAULT_LOCK_TTL_SEC).toBe(1200);
    expect(MAX_LOCK_TTL_SEC).toBe(3600);
    expect(MAX_LOCK_WAIT_SEC).toBe(300);
  });

  it('no lock tool re-declares the TTL / wait literals (the consolidated single source holds)', () => {
    const offenders: string[] = [];
    // A literal numeric re-declaration of any of the consolidated lock constants.
    const re = /\b(DEFAULT_TTL_SEC|MAX_TTL_SEC|MAX_WAIT_SEC)\s*=\s*\d/;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f === 'lock-config.ts' || f.endsWith('.test.ts')) continue;
      if (re.test(readFileSync(join(dir, f), 'utf8'))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
