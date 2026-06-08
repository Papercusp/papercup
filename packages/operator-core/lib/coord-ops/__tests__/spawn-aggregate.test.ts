/**
 * Unit tests for the last two coord-ops: orchestrator:spawn-roles (fan-out
 * expansion + cost guard, DI caps.spawnRoles) and vote:aggregate (the tally
 * wrapper over @papercusp/step-program's aggregateVotes, tested upstream).
 * Run with: cd packages/operator-core && npx vitest run lib/coord-ops/__tests__/spawn-aggregate.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import type { CoordOpCaps, CoordOpCtx, ResolvedSpawn } from '../types';
import { spawnRolesOp } from '../ops/spawn-roles';
import { aggregateOp } from '../ops/aggregate';

const makeCtx = (caps: Partial<CoordOpCaps>, over: Partial<CoordOpCtx> = {}): CoordOpCtx => ({
  identity: { ownerId: 'owner-1' },
  depth: 0,
  now: () => '2026-01-01T00:00:00.000Z',
  newId: (p) => `${p}-test`,
  caps: caps as CoordOpCaps,
  ...over,
});

const captureSpawn = () => {
  const spawnRoles = vi.fn(async (specs: ResolvedSpawn[]) => ({
    spawned: specs.map((s) => ({ role: s.role, inject: s.inject, ok: true })),
    launched: specs.length,
  }));
  return spawnRoles;
};

describe('spawnRolesOp', () => {
  it('expands one agent per `per` item, injecting it under `as`', async () => {
    const spawnRoles = captureSpawn();
    const a = spawnRolesOp.argsSchema.parse({
      conversation_id: 'c1',
      roles: [{ role: 'voter', per: ['security', 'perf', 'ux'], as: 'lens' }],
    });
    const out = await spawnRolesOp.run(a, makeCtx({ spawnRoles }, { blueprintId: 'vote' }));
    const specs = spawnRoles.mock.calls[0][0];
    expect(specs).toHaveLength(3);
    expect(specs.map((s) => s.inject.lens)).toEqual(['security', 'perf', 'ux']);
    expect(specs.every((s) => s.role === 'voter')).toBe(true);
    expect(specs.every((s) => s.inject.conversation_id === 'c1')).toBe(true);
    expect(specs.every((s) => s.blueprintId === 'vote')).toBe(true);
    expect(out.launched).toBe(3);
  });

  it('caps a per-expanded role at max_voters (cost guard D-008)', async () => {
    const spawnRoles = captureSpawn();
    const a = spawnRolesOp.argsSchema.parse({
      conversation_id: 'c',
      roles: [{ role: 'voter', per: Array.from({ length: 50 }, (_, i) => `lens${i}`), as: 'lens' }],
      max_voters: 5,
    });
    await spawnRolesOp.run(a, makeCtx({ spawnRoles }));
    expect(spawnRoles.mock.calls[0][0]).toHaveLength(5);
  });

  it('spawns `count` agents for a fixed role (default 1)', async () => {
    const spawnRoles = captureSpawn();
    const a = spawnRolesOp.argsSchema.parse({
      conversation_id: 'c',
      roles: [{ role: 'advocate', count: 2 }, { role: 'scribe' }],
    });
    await spawnRolesOp.run(a, makeCtx({ spawnRoles }));
    const specs = spawnRoles.mock.calls[0][0];
    expect(specs.filter((s) => s.role === 'advocate')).toHaveLength(2);
    expect(specs.filter((s) => s.role === 'scribe')).toHaveLength(1);
  });

  it('merges the base inject + conversation_id into every spec and applies persona', async () => {
    const spawnRoles = captureSpawn();
    const a = spawnRolesOp.argsSchema.parse({
      conversation_id: 'c',
      inject: { question: 'A or B?' },
      roles: [{ role: 'voter', count: 1, persona: 'skeptic' }],
    });
    await spawnRolesOp.run(a, makeCtx({ spawnRoles }));
    const spec = spawnRoles.mock.calls[0][0][0];
    expect(spec.inject).toMatchObject({ question: 'A or B?', conversation_id: 'c', role: 'voter', persona: 'skeptic' });
  });
});

describe('aggregateOp', () => {
  it('returns empty defaults for no posts', async () => {
    const a = aggregateOp.argsSchema.parse({ posts: [] });
    const out = await aggregateOp.run(a, makeCtx({}));
    expect(out).toMatchObject({ winner: null, margin: 0, mean_conf: 0, advocate_veto: false, votes: [] });
    expect(out.tally).toEqual({});
  });

  it('tallies confidence-weighted votes parsed from post bodies', async () => {
    const a = aggregateOp.argsSchema.parse({
      options: ['A', 'B'],
      posts: [
        { author_id: 'v1', body: 'option: A\nconfidence: 0.9' },
        { author_id: 'v2', body: 'option: A\nconfidence: 0.8' },
        { author_id: 'v3', body: 'option: B\nconfidence: 0.6' },
      ],
    });
    const out = await aggregateOp.run(a, makeCtx({}));
    expect(out.winner).toBe('A');
    expect(out.votes).toHaveLength(3);
    expect(out.tally.A).toBeGreaterThan(out.tally.B);
  });

  it('surfaces an advocate veto from a fenced advocate block', async () => {
    const a = aggregateOp.argsSchema.parse({
      options: ['A', 'B'],
      posts: [
        { author_id: 'v1', body: 'option: A\nconfidence: 0.9' },
        { author_id: 'adv', body: '```advocate\nveto: true\nobjection: A breaks the API\n```' },
      ],
    });
    const out = await aggregateOp.run(a, makeCtx({}));
    expect(out.advocate_veto).toBe(true);
    expect(out.objection).toMatch(/breaks the API/);
  });
});
