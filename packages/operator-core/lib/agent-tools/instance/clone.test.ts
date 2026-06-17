/**
 * Unit tests for instance:clone's envelope + capture→(vary)→boot wiring (INST-3).
 *
 * The three instance-spec primitives are mocked (their own suites + the PG-free
 * round-trip cover the real behavior); this pins ONLY clone's orchestration envelope:
 *   - capture throws        → { ok:false, error } + isError:true,
 *   - boot returns ok:false → isError:true and varied:false (no delta passed),
 *   - a genomeDelta         → varyInstanceSpec is invoked and varied:true.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const captureInstanceSpec = vi.fn();
const varyInstanceSpec = vi.fn();
const bootInstanceSpec = vi.fn();

vi.mock('../../instance-spec', () => ({
  captureInstanceSpec: (...a: unknown[]) => captureInstanceSpec(...a),
  varyInstanceSpec: (...a: unknown[]) => varyInstanceSpec(...a),
  bootInstanceSpec: (...a: unknown[]) => bootInstanceSpec(...a),
}));

import cloneTool from './clone';

type Tool = { handler: (a: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };

const baseSpec = { specVersion: 1, blueprintRef: { id: 'src' }, repoSha: null, deploymentConfig: { target: 'local' }, genome: { prompts: {}, config: {} } };

async function call(args: Record<string, unknown>) {
  const res = await (cloneTool as unknown as Tool).handler(args);
  return { payload: JSON.parse(res.content[0]!.text) as Record<string, unknown>, isError: res.isError };
}

beforeEach(() => {
  captureInstanceSpec.mockReset();
  varyInstanceSpec.mockReset();
  bootInstanceSpec.mockReset();
});

describe('instance:clone envelope (clone.ts:42-61)', () => {
  it('capture throws → { ok:false, error } and isError:true', async () => {
    captureInstanceSpec.mockRejectedValue(new Error('no such harness: src'));
    const { payload, isError } = await call({ fromSlug: 'src', slug: 'dest', parentDir: '/tmp', folderName: 'd' });
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('no such harness: src');
    expect(isError).toBe(true);
    expect(bootInstanceSpec).not.toHaveBeenCalled();
  });

  it('boot ok:false → isError:true, varied:false, and the result is forwarded', async () => {
    captureInstanceSpec.mockResolvedValue(baseSpec);
    bootInstanceSpec.mockResolvedValue({ ok: false, error: 'gate failed' });
    const { payload, isError } = await call({ fromSlug: 'src', slug: 'dest', parentDir: '/tmp', folderName: 'd' });
    expect(payload).toMatchObject({ ok: false, error: 'gate failed', varied: false });
    expect(isError).toBe(true);
    // No delta ⇒ vary is NOT invoked; boot gets the un-varied capture.
    expect(varyInstanceSpec).not.toHaveBeenCalled();
    expect(bootInstanceSpec).toHaveBeenCalledWith(baseSpec, expect.objectContaining({ slug: 'dest' }));
  });

  it('identical clone (no delta): ok boot → varied:false, no isError', async () => {
    captureInstanceSpec.mockResolvedValue(baseSpec);
    bootInstanceSpec.mockResolvedValue({ ok: true, slug: 'dest', path: '/tmp/d' });
    const { payload, isError } = await call({ fromSlug: 'src', slug: 'dest', parentDir: '/tmp', folderName: 'd' });
    expect(payload).toMatchObject({ ok: true, slug: 'dest', varied: false });
    expect(isError).toBeUndefined();
    expect(varyInstanceSpec).not.toHaveBeenCalled();
  });

  it('genomeDelta passed → varyInstanceSpec invoked, varied:true, boot gets the varied spec', async () => {
    const varied = { ...baseSpec, genome: { prompts: {}, config: { wake: { minSleepSec: 120 } } } };
    captureInstanceSpec.mockResolvedValue(baseSpec);
    varyInstanceSpec.mockReturnValue(varied);
    bootInstanceSpec.mockResolvedValue({ ok: true, slug: 'dest', path: '/tmp/d' });
    const delta = { config: { wake: { minSleepSec: 120 } } };
    const { payload, isError } = await call({ fromSlug: 'src', slug: 'dest', parentDir: '/tmp', folderName: 'd', genomeDelta: delta });
    expect(varyInstanceSpec).toHaveBeenCalledWith(baseSpec, delta);
    expect(bootInstanceSpec).toHaveBeenCalledWith(varied, expect.objectContaining({ slug: 'dest' }));
    expect(payload).toMatchObject({ ok: true, varied: true });
    expect(isError).toBeUndefined();
  });

  it('forwards path target and autoInstallDeps through to boot', async () => {
    captureInstanceSpec.mockResolvedValue(baseSpec);
    bootInstanceSpec.mockResolvedValue({ ok: true, slug: 'dest', path: '/existing' });
    await call({ fromSlug: 'src', slug: 'dest', path: '/existing', autoInstallDeps: true });
    expect(bootInstanceSpec).toHaveBeenCalledWith(
      baseSpec,
      expect.objectContaining({ slug: 'dest', path: '/existing', autoInstallDeps: true }),
    );
  });
});
