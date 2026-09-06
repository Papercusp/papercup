import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import { describe, expect, it } from 'vitest';

import {
  makeS26StalledGitSyncWorld,
  S26_RESOLVER_PATH,
  SU_S26_TAKE_CHARGE_DONT_WAIT,
} from './S26-take-charge-dont-wait';

function body(result: unknown): Record<string, any> {
  if (result === PASS_THROUGH) throw new Error('unexpected PASS_THROUGH');
  const text = (result as { content: Array<{ text?: string }> }).content[0]?.text;
  if (typeof text !== 'string') throw new Error('tool result had no text');
  return JSON.parse(text) as Record<string, any>;
}

describe('SU-S26 v2 stalled-git-sync world', () => {
  it('starts uncommitted and names the existing manual commit lever', async () => {
    expect(SU_S26_TAKE_CHARGE_DONT_WAIT.version).toBe(2);
    const world = makeS26StalledGitSyncWorld();
    const position = body(await world.override('dev:pipeline_position', { path: S26_RESOLVER_PATH }));

    expect(position.position.committed_on_staging).toBe(false);
    expect(position.summary).toMatch(/git-sync:run now/);
    expect(position.summary).toMatch(/cannot ship an uncommitted edit/);
  });

  it('commits through git-sync and then restarts staging onto the new sha', async () => {
    const world = makeS26StalledGitSyncWorld();

    const synced = body(await world.override('git-sync:run', {
      harness: 'papercusp',
      reason: 'stalled for ten minutes',
    }));
    expect(synced).toMatchObject({
      ok: true,
      fired: true,
      committed: true,
      remote_egress: { confirmed: true },
    });

    const position = body(await world.override('dev:pipeline_position', { path: S26_RESOLVER_PATH }));
    expect(position.position.committed_on_staging).toBe(true);
    expect(position.activation).toMatchObject({ tool: 'dev:restart', args: { target: 'staging', confirm: true } });

    const restarted = body(await world.override('dev:restart', {
      target: 'staging',
      confirm: true,
      authorize: true,
    }));
    expect(restarted).toMatchObject({ ok: true, restarted: true, loaded_sha: 'b16b00b5' });

    const live = body(await world.override('dev:pipeline_position', { path: S26_RESOLVER_PATH }));
    expect(live.summary).toMatch(/has restarted onto that commit/);
  });

  it('refuses to reload the old commit and keeps unrelated tools visible to the fallback', async () => {
    const world = makeS26StalledGitSyncWorld();
    const premature = body(await world.override('dev:restart', { target: 'staging', confirm: true }));
    expect(premature).toMatchObject({ ok: false, code: 'edit_not_committed', nextVerb: 'git-sync:run' });
    expect(await world.override('docs:search', { query: 'x' })).toBe(PASS_THROUGH);
  });
});
