/**
 * EI-19455334047866968 — dangling work-item refs in a written body.
 *
 * The probe is INJECTED throughout, so these run with no DB and no dynamic import.
 * The load-bearing case is `probe throws → silence`: that is the difference between
 * an advisory nudge and a check that manufactures phantom-ref accusations out of a
 * transient store fault.
 */
import { describe, it, expect, vi } from 'vitest';
import { unresolvedRefsInBody, unresolvedRefsWarning, MAX_REFS_PROBED } from './unresolved-refs';

/** A probe where only the listed ids exist. */
const probeWith = (...existing: string[]) => {
  const set = new Set(existing.map((s) => s.toUpperCase()));
  return vi.fn(async (id: string) => (set.has(id.toUpperCase()) ? { id } : null));
};

describe('unresolvedRefsInBody', () => {
  it('says nothing when the body cites no refs', async () => {
    const probe = probeWith();
    expect(await unresolvedRefsInBody('landed the fix, all green', { probe })).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([['', 'empty'], ['   ', 'whitespace'], [null, 'null'], [undefined, 'undefined']])(
    'says nothing for a %s body (%s)',
    async (body) => {
      expect(await unresolvedRefsInBody(body as string | null | undefined, { probe: probeWith() })).toBeUndefined();
    },
  );

  it('says nothing when every cited ref resolves', async () => {
    const probe = probeWith('EI-100', 'WI-200');
    expect(await unresolvedRefsInBody('see EI-100 and WI-200', { probe })).toBeUndefined();
  });

  it('reports a ref that resolves to nothing', async () => {
    const probe = probeWith('EI-100');
    const out = await unresolvedRefsInBody('filed as EI-999, superseding EI-100', { probe });
    expect(out?.missing).toEqual(['EI-999']);
  });

  it('reproduces the measured incident: a miscited freshly-minted id', async () => {
    // The real filing was EI-19454705610327667; the comment cited …3856572431492.
    const probe = probeWith('EI-19454705610327667');
    const out = await unresolvedRefsInBody('Filed as EI-19453856572431492', { probe });
    expect(out?.missing).toEqual(['EI-19453856572431492']);
  });

  it('reports several phantoms in one body, in order of appearance', async () => {
    const probe = probeWith('EI-2');
    const out = await unresolvedRefsInBody('EI-1 then EI-2 then EI-3', { probe });
    expect(out?.missing).toEqual(['EI-1', 'EI-3']);
  });

  // THE safety margin: a store that cannot answer is not evidence of a phantom.
  it('stays SILENT when the probe throws — never accuses on a store fault', async () => {
    const probe = vi.fn(async () => {
      throw new Error('PG connection lost');
    });
    expect(await unresolvedRefsInBody('see EI-999', { probe })).toBeUndefined();
  });

  it('reports only the refs it could judge when SOME probes throw', async () => {
    const probe = vi.fn(async (id: string) => {
      if (id === 'EI-1') throw new Error('transient');
      if (id === 'EI-2') return { id };
      return null;
    });
    const out = await unresolvedRefsInBody('EI-1 EI-2 EI-3', { probe });
    expect(out?.missing).toEqual(['EI-3']);
  });

  it('skips ids the caller already resolved, case-insensitively', async () => {
    const probe = probeWith();
    const out = await unresolvedRefsInBody('this item EI-500 is done', { probe, known: ['ei-500'] });
    expect(out).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('de-dupes a repeated ref into ONE probe and ONE report', async () => {
    const probe = probeWith();
    const out = await unresolvedRefsInBody('EI-7 blocks EI-7 which blocks EI-7', { probe });
    expect(out?.missing).toEqual(['EI-7']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not flag F- ids (excluded upstream as collision-prone in prose)', async () => {
    const probe = probeWith();
    expect(await unresolvedRefsInBody('see F-123', { probe })).toBeUndefined();
  });

  it('does not flag an id-like substring inside a larger token', async () => {
    const probe = probeWith();
    expect(await unresolvedRefsInBody('XEI-123 and blah-WI-9x', { probe })).toBeUndefined();
  });

  it('bounds the probes it will run', async () => {
    const probe = probeWith();
    const many = Array.from({ length: MAX_REFS_PROBED + 20 }, (_, i) => `EI-${i + 1}`).join(' ');
    const out = await unresolvedRefsInBody(many, { probe });
    expect(probe.mock.calls.length).toBeLessThanOrEqual(MAX_REFS_PROBED);
    expect(out?.missing.length).toBeLessThanOrEqual(MAX_REFS_PROBED);
  });

  it('probes nothing when max is 0', async () => {
    const probe = probeWith();
    expect(await unresolvedRefsInBody('EI-1', { probe, max: 0 })).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('unresolvedRefsWarning', () => {
  it('claims only non-RESOLUTION, never non-EXISTENCE', async () => {
    const w = unresolvedRefsWarning('EI-1', ['WI-3']);
    // WI-<n> ids come from a per-database sequence, so "does not exist" would be a
    // claim the resolution cannot support (see the module docstring).
    expect(w).toContain('does NOT resolve in this workspace');
    expect(w).not.toMatch(/does not exist|never existed in|no such work-item/i);
  });

  it('names every unresolved ref and stays singular/plural correct', () => {
    expect(unresolvedRefsWarning('EI-1', ['EI-9'])).toContain('a work-item ref that does');
    const many = unresolvedRefsWarning('EI-1', ['EI-9', 'EI-10']);
    expect(many).toContain('2 work-item refs that do');
    expect(many).toContain('EI-9, EI-10');
  });

  it('names the legitimate causes so it can be ignored without guilt', () => {
    const w = unresolvedRefsWarning('EI-1', ['EI-9']);
    expect(w).toMatch(/federated|another harness|deliberately quoted/i);
    expect(w).toContain('RECORDED');
  });
});
