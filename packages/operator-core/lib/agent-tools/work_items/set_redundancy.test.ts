/**
 * set_redundancy.test.ts — the work_items:set_redundancy HANDLER shaping (the write
 * itself, setItemRedundancy, is covered in work-item-redundancy.test.ts). This pins
 * the handler-only logic: not-found mapping, the highStakes threshold (redundancy >=
 * MIN_REDUNDANCY), and the "inert until the master switch is on" UX — `active`
 * reflects PAPERCUSP_WORKITEM_REDUNDANCY and a clarifying `note` appears only when it
 * is OFF (so a caller isn't surprised the item still runs exactly-once). A regression
 * that drops that note, or flips the high-stakes threshold, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/set_redundancy.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MIN_REDUNDANCY mirrors the real const (2); workItemRedundancyEnabled is the real
// one-liner so we drive `active` purely via env. setItemRedundancy is stubbed.
vi.mock('../../work-item-redundancy', () => ({
  setItemRedundancy: vi.fn(),
  workItemRedundancyEnabled: () => process.env.PAPERCUSP_WORKITEM_REDUNDANCY === '1',
  MIN_REDUNDANCY: 2,
}));

import { setItemRedundancy } from '../../work-item-redundancy';
const setRed = vi.mocked(setItemRedundancy);
const tool = (await import('./set_redundancy')).default;

type Out = { content: { text: string }[] };
const call = (redundancy: number, id = 'F-1', harness?: string) =>
  tool.handler({ id, redundancy, harness } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.PAPERCUSP_WORKITEM_REDUNDANCY;
  delete process.env.PAPERCUSP_WORKITEM_REDUNDANCY;
  setRed.mockReset();
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PAPERCUSP_WORKITEM_REDUNDANCY;
  else process.env.PAPERCUSP_WORKITEM_REDUNDANCY = savedEnv;
});

describe('work_items:set_redundancy handler', () => {
  it('maps a falsy write (not feature-family / missing) to an error', async () => {
    setRed.mockResolvedValue(null as never);
    const b = body(await call(2));
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/not found|feature-family/i);
  });

  it('redundancy >= MIN flags highStakes; with the master switch OFF it adds the inert note', async () => {
    setRed.mockResolvedValue({ id: 'F-1', harness: 'web', redundancy: 2 } as never);
    const b = body(await call(2));
    expect(b).toMatchObject({ ok: true, id: 'F-1', redundancy: 2, highStakes: true, active: false });
    expect(String(b.note)).toMatch(/OFF|exactly-once/i);
  });

  it('with the master switch ON, active is true and no inert note is surfaced', async () => {
    process.env.PAPERCUSP_WORKITEM_REDUNDANCY = '1';
    setRed.mockResolvedValue({ id: 'F-1', harness: 'web', redundancy: 3 } as never);
    const b = body(await call(3));
    expect(b).toMatchObject({ ok: true, highStakes: true, active: true });
    expect(b.note).toBeUndefined();
  });

  it('redundancy 1 clears high-stakes (back to exactly-once)', async () => {
    setRed.mockResolvedValue({ id: 'F-1', harness: 'web', redundancy: 1 } as never);
    const b = body(await call(1));
    expect(b).toMatchObject({ ok: true, redundancy: 1, highStakes: false });
  });
});
