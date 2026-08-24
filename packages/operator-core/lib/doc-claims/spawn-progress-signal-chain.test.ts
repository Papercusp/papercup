/**
 * WI-6113: the emitted progress-signal chain for in-process loopback launches
 * must stay joined. See `spawn-progress-signal-chain.ts` for why a per-hop unit
 * test cannot see this break and why production data cannot falsify it.
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the sibling doc-claims
 * tests state: once the live assertion goes green it stops being evidence that
 * the detector works at all. Each fixture below reproduces a break that MUST be
 * caught — including the exact WI-3302 shape (every hop individually correct,
 * the chain silently severed) and the 2-arg keepalive "simplification" that
 * would re-break the class without touching a single test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgeProgressSignalChain,
  callArguments,
  topLevelArity,
  type ChainSources,
} from './spawn-progress-signal-chain';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const PATHS = {
  invoke: join(ROOT, 'libs/papercusp/packages/orchestrator/src/invoke.ts'),
  route: join(ROOT, 'packages/operator-core/lib/endpoint-route/routes/harness/spawn.ts'),
  durableSpawn: join(ROOT, 'packages/operator-core/lib/dbos/durable-spawn.ts'),
  launchBlueprint: join(ROOT, 'packages/operator-core/lib/blueprint/launch-blueprint.ts'),
} as const;

/** Pad a fixture past the unreadable-source floor so we test the RULE, not the guard. */
const pad = (body: string): string => `${body}\n${'// filler\n'.repeat(40)}`;

/** A synthetic chain where all four hops are joined. */
const HEALTHY: ChainSources = {
  invoke: pad(`
    export const OUTER_ACTIVITY_ECHO_MARKER = '[papercusp:activity]';
    const echoActivityToOuterProcess = () => {
      process.stderr.write(\`\${OUTER_ACTIVITY_ECHO_MARKER}\\n\`);
    };
  `),
  route: pad(`
    const persistSpawnOutputActivity = () => {
      void spawnTracking.heartbeatSpawns(getOrgPg().sql, [spawnRecordId], new Map([[spawnRecordId, observedAt]]));
    };
    const r = await spawnInvokeOnce(dir, role, extra, env, {
      onOutputActivity: persistSpawnOutputActivity,
    });
  `),
  durableSpawn: pad(`const fireBody = { ...rest, spawnRecordId: spawnId };`),
  launchBlueprint: pad(`const invokeBody = { ...body, spawnRecordId: spawnId };`),
};

describe('spawn progress-signal chain — argument scanner', () => {
  it('counts top-level arguments without being fooled by nesting', () => {
    expect(topLevelArity('sql, [a], new Map([[a, b]])')).toBe(3);
    expect(topLevelArity('sql, [a, b, c]')).toBe(2);
    expect(topLevelArity('')).toBe(0);
  });

  it('is not fooled by a comma inside a string literal', () => {
    expect(topLevelArity(`sql, 'a, b, c'`)).toBe(2);
    expect(topLevelArity('sql, `x, ${y}, z`')).toBe(2);
  });

  it('extracts balanced argument text for each call site', () => {
    const args = callArguments('f(a, g(b, c)); f(d)', 'f');
    expect(args).toEqual(['a, g(b, c)', 'd']);
  });
});

describe('spawn progress-signal chain — fixture controls (the detector must be able to FAIL)', () => {
  it('catches the WI-3302 shape: invoke.ts stops echoing to its own stderr', () => {
    const verdict = judgeProgressSignalChain({
      ...HEALTHY,
      // The marker is still DEFINED and still forwarded to the chunk bus — every
      // hop still looks correct in isolation. Only the echo is gone.
      invoke: pad(`
        export const OUTER_ACTIVITY_ECHO_MARKER = '[papercusp:activity]';
        const forward = (chunk) => postToChunkBus(chunk);
      `),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.echoSites).toBe(0);
    expect(verdict.violations.join('\n')).toMatch(/hop 1 broken/);
    expect(verdict.violations.join('\n')).toMatch(/WI-3302/);
  });

  it('catches the route dropping the onOutputActivity wiring', () => {
    const verdict = judgeProgressSignalChain({
      ...HEALTHY,
      route: pad(`
        const r = await spawnInvokeOnce(dir, role, extra, env, { onChildPid: notePid });
      `),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.wiringSites).toBe(0);
    expect(verdict.violations.join('\n')).toMatch(/hop 3 broken/);
  });

  it('catches the 2-arg keepalive "simplification" of the stamper', () => {
    const verdict = judgeProgressSignalChain({
      ...HEALTHY,
      route: pad(`
        const persistSpawnOutputActivity = () => {
          void spawnTracking.heartbeatSpawns(getOrgPg().sql, [spawnRecordId]);
        };
        const r = await spawnInvokeOnce(dir, role, extra, env, {
          onOutputActivity: persistSpawnOutputActivity,
        });
      `),
    });
    expect(verdict.ok).toBe(false);
    // The wiring is intact — only the ARITY regressed. This is the break that a
    // presence-of-identifier check would wave through.
    expect(verdict.wiringSites).toBe(1);
    expect(verdict.stampingCalls).toBe(0);
    expect(verdict.keepaliveCalls).toBe(1);
    expect(verdict.violations.join('\n')).toMatch(/hop 3 degraded/);
  });

  it('catches a launch caller dropping spawnRecordId', () => {
    const verdict = judgeProgressSignalChain({
      ...HEALTHY,
      durableSpawn: pad(`const fireBody = { ...rest };`),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.recordIdCallers).toEqual(['launchBlueprint']);
    expect(verdict.violations.join('\n')).toMatch(/hop 4 broken: durableSpawn/);
  });

  it('reports an unreadable source as an INSTRUMENT failure, never as a clean pass', () => {
    const verdict = judgeProgressSignalChain({ ...HEALTHY, route: '' });
    expect(verdict.ok).toBe(false);
    expect(verdict.unjudgeable).toEqual(['route']);
    expect(verdict.violations.join('\n')).toMatch(/instrument failure/);
    // The point of the distinction: an empty read must not be reported as the
    // route merely "having no violations".
    expect(verdict.violations.join('\n')).not.toMatch(/hop 3 broken/);
  });

  it('calibration: the healthy synthetic chain passes', () => {
    const verdict = judgeProgressSignalChain(HEALTHY);
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

describe('spawn progress-signal chain — live sources', () => {
  it('the four real hops are still joined', () => {
    const sources = Object.fromEntries(
      Object.entries(PATHS).map(([k, p]) => [k, readFileSync(p, 'utf8')]),
    ) as unknown as ChainSources;

    const verdict = judgeProgressSignalChain(sources);
    expect(verdict.unjudgeable).toEqual([]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.echoSites).toBeGreaterThanOrEqual(1);
    expect(verdict.stampingCalls).toBeGreaterThanOrEqual(1);
    expect(verdict.recordIdCallers).toEqual(['durableSpawn', 'launchBlueprint']);
  });
});
