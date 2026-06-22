import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * EI-2434 CLASS recurrence guard — no freeze-detection watchdog may use journalctl
 * (journal SILENCE) as its liveness signal.
 *
 * Root incident: journald's stdout-socket capture wedged host-wide (a runaway process
 * flooded it with millions of msgs/30s → rate-limit suppression dropped other units'
 * logs). Watchdogs that decided "frozen" from `journalctl … --since` returning 0 lines
 * then FALSE-restarted perfectly healthy hosts → EI-2186 boot-reconcile reclaimed every
 * in-flight bee spawn (the 2026-06-22 canary deaths). The fix made both watchdogs read
 * REAL liveness — bg-host from Postgres `MAX(last_fired_at)`, the inference-gateway from
 * its in-process request counters — neither of which a journald fault can fake.
 *
 * This guard locks that in: a watchdog must never again exec journalctl to infer
 * liveness. We scan the watchdog sources with COMMENTS STRIPPED (the files legitimately
 * discuss the journalctl history in prose), so only a real `journalctl` call trips it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const WATCHDOGS = [
  resolve(HERE, '../bghost-watchdog.mjs'),
  resolve(REPO, 'packages/operator-core/lib/inference-gateway/watchdog.mjs'),
];

/** Remove block comments, JSDoc `*` lines, and `//` line comments so the assertion
 *  tests executable CODE, not the historical prose that explains the journalctl bug. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .filter((l) => !l.trim().startsWith('*'))
    .join('\n');
}

describe('watchdog journald-independence (EI-2434 class recurrence guard)', () => {
  it('every known watchdog script exists (paths stay correct as the guard set grows)', () => {
    for (const p of WATCHDOGS) {
      expect(() => readFileSync(p, 'utf8'), `watchdog not found: ${p}`).not.toThrow();
    }
  });

  for (const path of WATCHDOGS) {
    const name = path.split('/').pop();
    it(`${name} does NOT exec journalctl for freeze/liveness detection`, () => {
      const code = stripComments(readFileSync(path, 'utf8'));
      expect(
        code,
        `${name} must derive liveness from REAL state (PG / in-process counters), never journalctl-silence — a wedged journald makes a HEALTHY host look frozen and triggers false restarts that kill in-flight spawns (EI-2434).`,
      ).not.toMatch(/journalctl/);
    });
  }
});
