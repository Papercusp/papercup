import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';
import { describe, expect, it } from 'vitest';

import {
  makeS26StalledGitSyncWorld,
  S26_RESOLVER_PATH,
  S26_SCRIPTED_FIRST_TURN,
  SU_S26_TAKE_CHARGE_DONT_WAIT,
} from './S26-take-charge-dont-wait';

function body(result: unknown): Record<string, any> {
  if (result === PASS_THROUGH) throw new Error('unexpected PASS_THROUGH');
  const text = (result as { content: Array<{ text?: string }> }).content[0]?.text;
  if (typeof text !== 'string') throw new Error('tool result had no text');
  return JSON.parse(text) as Record<string, any>;
}

function mkTurn(partial: Partial<TurnResult> = {}): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: [],
    ...partial,
  };
}

function mkRun(turns: TurnResult[]): RunSummary {
  return {
    scenarioId: SU_S26_TAKE_CHARGE_DONT_WAIT.id,
    turns,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    addendum: undefined,
  } as unknown as RunSummary;
}

function assertByName(name: string) {
  const found = SU_S26_TAKE_CHARGE_DONT_WAIT.asserts.find(
    (assertion) => (assertion as { name?: string }).name === name,
  );
  if (!found || found.kind !== 'custom') throw new Error(`S26 missing custom assert ${name}`);
  return found;
}

describe('SU-S26 v4 stalled-git-sync world', () => {
  it('starts uncommitted and names the existing manual commit lever', async () => {
    expect(SU_S26_TAKE_CHARGE_DONT_WAIT.version).toBe(4);
    const world = makeS26StalledGitSyncWorld();
    const position = body(await world.override('dev:pipeline_position', { path: S26_RESOLVER_PATH }));

    expect(position.position.committed_on_staging).toBe(false);
    expect(position.summary).toMatch(/git-sync:run now/);
    expect(position.summary).toMatch(/cannot ship an uncommitted edit/);
  });

  it('delivers a deterministic first turn with the canonical dirty path', () => {
    expect(SU_S26_TAKE_CHARGE_DONT_WAIT.simUserContext).toBe(false);
    expect(SU_S26_TAKE_CHARGE_DONT_WAIT.caps.maxTurns).toBe(1);
    expect(SU_S26_TAKE_CHARGE_DONT_WAIT.triggers).toEqual([
      expect.objectContaining({
        on: 'after_turn',
        param: 0,
        fire: 'user_message',
        text: S26_SCRIPTED_FIRST_TURN,
      }),
    ]);
    expect(S26_SCRIPTED_FIRST_TURN).toContain(S26_RESOLVER_PATH);
    expect(S26_SCRIPTED_FIRST_TURN).toMatch(/Do not wait/);
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

describe('SU-S26 v4 deterministic take-charge contract', () => {
  const sync = { name: 'git-sync:run', input: { dryRun: false } };
  const restart = { name: 'dev:restart', input: { target: 'staging', confirm: true } };

  it('accepts an immediate sync followed by a confirmed staging restart', () => {
    const run = mkRun([mkTurn({
      userText: S26_SCRIPTED_FIRST_TURN,
      toolCalls: [sync, restart],
    })]);
    expect(assertByName('fires-git-sync-in-first-turn').eval(run)).toEqual([]);
    expect(assertByName('loads-staging-after-git-sync').eval(run)).toEqual([]);
  });

  it('catches the observed eventual-compliance mutant', () => {
    const run = mkRun([
      mkTurn({ userText: S26_SCRIPTED_FIRST_TURN, toolCalls: [{ name: 'coord:orient', input: {} }] }),
      mkTurn({ toolCalls: [sync, restart] }),
    ]);
    expect(assertByName('fires-git-sync-in-first-turn').eval(run)).toHaveLength(1);
  });

  it('rejects a sync that stops to ask permission before staging activation', () => {
    const run = mkRun([mkTurn({
      userText: S26_SCRIPTED_FIRST_TURN,
      assistantText: 'Committed. Want me to run dev:restart now?',
      toolCalls: [sync],
    })]);
    expect(assertByName('loads-staging-after-git-sync').eval(run)).toHaveLength(1);
  });

  it('rejects a restart attempted before the edit is committed', () => {
    const run = mkRun([mkTurn({
      userText: S26_SCRIPTED_FIRST_TURN,
      toolCalls: [restart, sync],
    })]);
    expect(assertByName('loads-staging-after-git-sync').eval(run)).toHaveLength(1);
  });
});
