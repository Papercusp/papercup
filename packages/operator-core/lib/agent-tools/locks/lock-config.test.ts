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
import acquireTool from './acquire';

const dir = dirname(fileURLToPath(import.meta.url));

describe('lock-config — single source (P-013 / D-006)', () => {
  it('exposes the canonical lock TTL / wait defaults', () => {
    expect(DEFAULT_LOCK_TTL_SEC).toBe(1200);
    expect(MAX_LOCK_TTL_SEC).toBe(3600);
    expect(MAX_LOCK_WAIT_SEC).toBe(45);
  });

  it('keeps locks:acquire discovery and validation aligned at the live TTL boundary', () => {
    const base = { paths: ['a.ts'], intent: 'probe' };
    expect(
      acquireTool.args.safeParse({ ...base, ttl_sec: MAX_LOCK_TTL_SEC }).success,
    ).toBe(true);
    expect(
      acquireTool.args.safeParse({ ...base, ttl_sec: MAX_LOCK_TTL_SEC + 1 }).success,
    ).toBe(false);
  });

  it('blocking wait ceiling stays under the ~55s MCP client deadline (EI-21389299859182434)', () => {
    // The MCP client kills a call at ~55s (-32001, unknown outcome) while the server keeps
    // blocking to wait.max_sec. The ceiling plus the handler's post-wait tail (expireWaiter +
    // busy re-read + enrichBusy, budgeted ~10s under fleet load) must return BEFORE that
    // deadline, or every long blocking wait strands its caller and the post-timeout
    // lucky-race grant can orphan a lock until TTL. 300s sat here until 2026-08-25.
    const MCP_CLIENT_DEADLINE_SEC = 55;
    const POST_WAIT_TAIL_BUDGET_SEC = 10;
    expect(MAX_LOCK_WAIT_SEC + POST_WAIT_TAIL_BUDGET_SEC).toBeLessThanOrEqual(MCP_CLIENT_DEADLINE_SEC);
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
