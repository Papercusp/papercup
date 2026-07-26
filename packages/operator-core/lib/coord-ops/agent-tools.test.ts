/**
 * agent-tools.test.ts — the agent-facing `coord:ask-owner` TOOL's args schema
 * (EI-18682693723293580 recurrence guard).
 *
 * Bug: calling `coord:ask-owner` from inside `code:run` (foreground, ~55s hard
 * cap) ALWAYS script_timeout'd, because the exposed tool inherited the
 * internal `coord:ask` op's `timeout_s: 120` default and blocked in a 2s poll
 * loop — the write (open thread + escalate) had already landed by the time
 * the caller's script budget ran out, leaving a live double-post risk with no
 * cheap way to check what landed.
 *
 * Fix: the exposed tool (agent-tools.ts) declares its own `askOwnerArgs`
 * schema, identical to the op's except `timeout_s` defaults to 0 — return
 * immediately once the question is opened. This test pins that schema
 * default; `coord-ops/__tests__/compose.test.ts` pins the companion op-level
 * fix (timeout_s<=0 skips the poll loop entirely, not "one 2s poll").
 *
 * The tool itself registers into the PROJECTED tool registry (role-gated,
 * `requirePrincipal: false`), whose `handler` is wrapped behind payload-tier
 * shaping + StandardSchema validation + a UnifiedToolContext — no cheap unit
 * seam. `askOwnerArgs` is exported for exactly this reason: it is the one
 * piece of the wrapper a unit test can assert on directly without standing
 * up that machinery.
 *
 * Run: cd packages/operator-core && npx vitest run lib/coord-ops/agent-tools.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { askOwnerArgs } from './agent-tools';
import { askOp } from './ops/compose';
import type { CoordOpCaps, CoordOpCtx } from './types';

const makeCtx = (caps: Partial<CoordOpCaps>): CoordOpCtx => ({
  identity: { ownerId: 'owner-1' },
  depth: 0,
  now: () => '2026-01-01T00:00:00.000Z',
  newId: (p) => `${p}-test`,
  caps: caps as CoordOpCaps,
});

describe('coord:ask-owner tool args (askOwnerArgs)', () => {
  it('defaults timeout_s to 0 — NOT the op\'s 120s default', () => {
    const parsed = askOwnerArgs.parse({ question: 'A or B?' });
    expect(parsed.timeout_s).toBe(0);
  });

  it('still accepts an explicit positive timeout_s for a caller that genuinely wants to block', () => {
    const parsed = askOwnerArgs.parse({ question: 'q', timeout_s: 30 });
    expect(parsed.timeout_s).toBe(30);
  });

  it('rejects a negative timeout_s (matches the op\'s nonnegative constraint)', () => {
    expect(() => askOwnerArgs.parse({ question: 'q', timeout_s: -1 })).toThrow();
  });

  it('end-to-end: parsed default args resolve immediately via askOp.run — no poll, no sleep', async () => {
    const caps = {
      openThread: vi.fn().mockResolvedValue({ thread_id: 't1', conversation_id: 'c1' }),
      escalate: vi.fn().mockResolvedValue({ msg_id: 'e1' }),
      sleep: vi.fn().mockResolvedValue(undefined),
      readAnswer: vi.fn().mockResolvedValue({ answered: false, answer: null }),
    };
    const args = askOwnerArgs.parse({ question: 'Ship it?' });
    const out = await askOp.run(args, makeCtx(caps));
    expect(out).toEqual({ answered: false, answer: null, conversation_id: 'c1' });
    expect(caps.sleep).not.toHaveBeenCalled();
    expect(caps.readAnswer).toHaveBeenCalledTimes(1);
  });
});
