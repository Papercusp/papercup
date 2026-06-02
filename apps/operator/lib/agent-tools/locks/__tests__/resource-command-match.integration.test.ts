/**
 * resource-command-match — the raw-Bash matcher (Phase 8, P-026 / D-012/D-013).
 *
 * matchCommandToResources maps a shell command to registered resources via
 * their match_patterns (the small, matchable DESTRUCTIVE set). checkBashCommand
 * adds the live drain verdict a PreToolUse Bash hook would act on. The pure
 * matcher is unit-tested; checkBashCommand is live (reads the registry + drain
 * state). NOTE: the hook is NOT wired into settings.json here — see docs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureBootstrap,
  getTxPool,
  _resetForTests,
  tryAcquireResource,
  type ResourceRegistryRow,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import {
  matchCommandToResources,
  checkBashCommand,
} from '../resource-command-match';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
const uniqueWs = () => `cmd-match-ws-${Date.now()}-${seq++}`;

const reg = (resource: string, patterns: string[], enforcement: ResourceRegistryRow['enforcement'] = 'checked'): ResourceRegistryRow => ({
  resource,
  description: '',
  rule_text: '',
  enforcement,
  match_patterns: patterns,
});

describe('matchCommandToResources (pure)', () => {
  const registry = [
    reg('dev-server', ['systemctl.*restart.*papercup', 'overmind.*restart']),
    reg('db-schema', ['psql.*-f']),
  ];

  it('matches a dev-server restart command', () => {
    const m = matchCommandToResources('systemctl --user restart papercup-dev-api.service', registry);
    expect(m.map((r) => r.resource)).toEqual(['dev-server']);
  });

  it('matches a psql migration command to db-schema', () => {
    const m = matchCommandToResources('psql "$DATABASE_URL" -f migrations/107.sql', registry);
    expect(m.map((r) => r.resource)).toEqual(['db-schema']);
  });

  it('matches nothing for an unrelated command', () => {
    expect(matchCommandToResources('ls -la && grep foo bar.txt', registry)).toEqual([]);
  });

  it('ignores resources with no patterns', () => {
    expect(matchCommandToResources('anything', [reg('x', [])])).toEqual([]);
  });
});

describe('checkBashCommand (live drain verdict)', async () => {
  const live = await dbLive();
  beforeAll(async () => {
    if (live) await ensureBootstrap();
  });

  it.skipIf(!live)('blocks a matched command while another agent holds the exclusive (checked)', async () => {
    const ws = uniqueWs();
    // Y holds dev-server exclusive.
    await inWorkspaceTxn(ws, 'Y', (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: ws,
        resource: 'dev-server',
        mode: 'exclusive',
        owner: 'Y',
        ownerLabel: 'res:Y',
        reason: 'restart',
        ttlSec: 60,
      }),
    );

    const verdict = await checkBashCommand({
      command: 'systemctl --user restart papercup-dev-api.service',
      coordinationDomain: ws,
    });
    expect(verdict.matched.map((m) => m.resource)).toContain('dev-server');
    // dev-server is seeded 'advisory'; a held exclusive → warn (not hard block).
    expect(['warn', 'block']).toContain(verdict.decision);
    expect(verdict.matched.find((m) => m.resource === 'dev-server')?.exclusiveActive).toBe(true);
  });

  it.skipIf(!live)('allows an unmatched command', async () => {
    const ws = uniqueWs();
    const verdict = await checkBashCommand({ command: 'echo hello', coordinationDomain: ws });
    expect(verdict.decision).toBe('allow');
    expect(verdict.matched).toEqual([]);
    await _resetForTests();
  });
});
