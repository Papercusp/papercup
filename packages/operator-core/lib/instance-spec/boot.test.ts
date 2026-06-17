/**
 * Unit tests for `bootInstanceSpec`'s pre/post-`harness:create` guards (INST-1):
 *   - the missing-target guard short-circuits BEFORE any create call,
 *   - unparseable create output → a clean error envelope,
 *   - a create `{ ok: false }` is surfaced verbatim with the raw payload preserved.
 *
 * The dependency (`harness:create`'s default handler) is mocked so these stay pure —
 * the happy path + real create wiring is the PG-free round-trip in `roundtrip.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the create tool's default export — `boot.ts` reaches for `.handler` and calls
// it with the create args alone (it ignores ctx). Each test drives `createHandler`.
const createHandler = vi.fn();
vi.mock('../agent-tools/harness/create', () => ({
  default: { handler: (...a: unknown[]) => createHandler(...a) },
}));

import { bootInstanceSpec } from './boot';
import type { InstanceSpec } from './types';

const spec: InstanceSpec = {
  specVersion: 1,
  blueprintRef: { id: 'demo', extends: 'coding', blueprint: { id: 'demo', extends: 'coding' } },
  repoSha: null,
  deploymentConfig: { target: 'local' },
  genome: { prompts: {}, config: {} },
};

/** A create handler result shaped like the real tool's MCP envelope. */
const createReturning = (text: string) => ({ content: [{ type: 'text', text }] });

beforeEach(() => {
  createHandler.mockReset();
});

describe('bootInstanceSpec — missing-target guard (boot.ts:58-61)', () => {
  it('with only a slug → { ok:false } error and NO harness:create call', async () => {
    const res = await bootInstanceSpec(spec, { slug: 'clone' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/pass `path`/);
    expect(createHandler).not.toHaveBeenCalled();
  });

  it('with parentDir but no folderName → short-circuits without calling create', async () => {
    const res = await bootInstanceSpec(spec, { slug: 'clone', parentDir: '/tmp/x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/pass `path`/);
    expect(createHandler).not.toHaveBeenCalled();
  });
});

describe('bootInstanceSpec — malformed create output (boot.ts:81-90)', () => {
  it('non-JSON content → { ok:false, error: unparseable } with the raw text', async () => {
    createHandler.mockResolvedValue(createReturning('not json'));
    const res = await bootInstanceSpec(spec, { slug: 'clone', path: '/tmp/dest' });
    expect(res).toMatchObject({ ok: false, error: 'harness:create returned unparseable output', raw: 'not json' });
    expect(createHandler).toHaveBeenCalledTimes(1);
  });

  it('a create { ok:false, error } is surfaced verbatim with the raw payload preserved', async () => {
    const failure = { ok: false, error: 'gate failed' };
    createHandler.mockResolvedValue(createReturning(JSON.stringify(failure)));
    const res = await bootInstanceSpec(spec, { slug: 'clone', path: '/tmp/dest' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('gate failed');
    expect(res.raw).toEqual(failure);
  });

  it('missing content (empty envelope) defaults to {} → ok:false with the fallback error', async () => {
    createHandler.mockResolvedValue({});
    const res = await bootInstanceSpec(spec, { slug: 'clone', path: '/tmp/dest' });
    // text defaults to '{}', which parses to {} → parsed.ok !== true.
    expect(res.ok).toBe(false);
    expect(res.error).toBe('harness:create failed');
  });
});
