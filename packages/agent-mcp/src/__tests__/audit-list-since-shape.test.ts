/**
 * EI-20216014898419956 — `audit:list` takes `sinceTs` while neighbouring
 * time-filter tools take `since`.
 *
 * The item offered two remedies: (a) accept `since` as an alias, or (b) make
 * the millisecond-integer shape discoverable before rejection. Measuring
 * first showed (a) was ALREADY delivered — tooldef's edit-distance rung
 * resolves `since` -> `sinceTs` (distance 2, threshold 2) — so only (b) was
 * real work.
 *
 * Investigating (b) surfaced a defect strictly worse than the one filed: a
 * wrong-unit value was not merely undocumented, it was SILENTLY ACCEPTED.
 * Epoch seconds is a valid integer, so `sinceTs: 1788000000` passed
 * validation and then matched essentially every row — a forensic query with
 * the wrong unit returned a full result set that reads exactly like a
 * correctly-filtered one. Describing that trap only documents it; the schema
 * now REFUSES it, which is why the load-bearing assertions below are
 * behavioural (does the schema reject?) rather than textual (does the prose
 * mention it?).
 *
 * These cases are deliberately NOT of equal evidentiary weight:
 *
 *   - The rejection/acceptance pair DISCRIMINATES: the rejection case fails
 *     against the pre-fix source, where a seconds value parsed cleanly.
 *   - The did-you-mean case is a FUTURE-REGRESSION guard only. It passed
 *     before any of this work, because that rung already worked. It is here
 *     so a later edit to `ARG_TYPE_SUFFIXES`, the threshold formula, or the
 *     accepted-key set cannot silently take the name half away again.
 *
 * Do not read the did-you-mean case as evidence for the fix; it is a latch,
 * not a measurement.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
// The `./define-tool` subpath, not the barrel: `suggestArgName` is exported
// from define-tool.ts but deliberately not re-exported by src/index.ts.
import { suggestArgName } from '@papercusp/tooldef/define-tool';
import auditList, { MS_EPOCH_FLOOR } from '../tools/audit/list';

/** A real epoch-MILLISECONDS instant (2026-08-01). */
const MS_VALUE = 1_785_000_000_000;
/** The SAME instant expressed in epoch SECONDS — the wrong-unit input. */
const SECONDS_VALUE = Math.floor(MS_VALUE / 1000);

function argsSchema(): z.ZodType {
  return (auditList as unknown as { args: z.ZodType }).args;
}

/**
 * Render the tool's own declared schema the way a caller sees it.
 *
 * Must be zod's own `z.toJSONSchema(..., { io: 'input' })`. The
 * `zodToJsonSchema` package returns a bare `{ $schema }` for zod 4 (this repo
 * is zod 4.x), which makes subject AND control both come back empty and reads
 * like a real finding instead of a dead instrument.
 */
function inputSchema(): {
  properties?: Record<string, { description?: string; minimum?: number }>;
} {
  return z.toJSONSchema(argsSchema(), { io: 'input' }) as ReturnType<typeof inputSchema>;
}

describe('audit:list sinceTs shape (EI-20216014898419956)', () => {
  it('CONTROL: the rendered schema is non-empty, so an absent description is a real absence', () => {
    // Without this, a broken renderer would make every schema assertion below vacuous.
    const props = inputSchema().properties ?? {};
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['detail', 'actor', 'action', 'sinceTs', 'limit', 'workspace']),
    );
  });

  it('CONTROL: the wrong-unit fixture really is the same instant, so the pair below is a unit test', () => {
    // Guards the fixtures themselves: if these drifted apart, the
    // reject/accept pair could pass for reasons unrelated to units.
    expect(SECONDS_VALUE * 1000).toBe(MS_VALUE);
    expect(MS_VALUE).toBeGreaterThanOrEqual(MS_EPOCH_FLOOR);
    expect(SECONDS_VALUE).toBeLessThan(MS_EPOCH_FLOOR);
  });

  it('DISCRIMINATING: an epoch-SECONDS value is REJECTED, not silently accepted', () => {
    // The load-bearing case, and the one that fails against the pre-fix
    // source. Before the floor, this parsed cleanly and then matched ~every
    // row — a wrong unit produced a full result set rather than an error.
    const parsed = argsSchema().safeParse({ sinceTs: SECONDS_VALUE });
    expect(parsed.success).toBe(false);
  });

  it('DISCRIMINATING: the refusal names the repair rather than just failing', () => {
    // A bare "too_small" would leave the caller guessing at the unit, which is
    // the discoverability half of the original item.
    const parsed = argsSchema().safeParse({ sinceTs: SECONDS_VALUE });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? '' : parsed.error.issues.map((i) => i.message).join(' ');
    expect(message).toMatch(/millisecond/i);
    expect(message).toMatch(/second/i);
    expect(message).toMatch(/1000/);
  });

  it('CONTROL: a real epoch-MILLISECONDS value is still ACCEPTED', () => {
    // Proves the rejection above discriminates on the UNIT rather than the
    // schema having become uniformly hostile — without this, deleting the
    // whole arg would pass the case above.
    const parsed = argsSchema().safeParse({ sinceTs: MS_VALUE });
    expect(parsed.success).toBe(true);
  });

  it('CONTROL: omitting sinceTs remains valid (the filter is optional)', () => {
    expect(argsSchema().safeParse({}).success).toBe(true);
  });

  it('the floor is DISCOVERABLE in the rendered schema, not only on rejection', () => {
    // Remedy (b) as filed: the shape should be visible BEFORE a caller is
    // refused, so the advertised inputSchema has to carry the bound.
    expect(inputSchema().properties?.sinceTs?.minimum).toBe(MS_EPOCH_FLOOR);
  });

  it('DISCRIMINATING: sinceTs declares its unit as epoch milliseconds', () => {
    const description = inputSchema().properties?.sinceTs?.description ?? '';
    expect(description).not.toEqual('');
    expect(description).toMatch(/millisecond/i);
  });

  it('the description states that seconds is REJECTED (it no longer silently matches)', () => {
    // Pinned so the prose cannot drift back to describing the old, fixed
    // behaviour — a description that still promised silent acceptance would
    // be worse than none now that the schema refuses.
    const description = inputSchema().properties?.sinceTs?.description ?? '';
    expect(description).toMatch(/second/i);
    expect(description).toMatch(/reject/i);
  });

  it('FUTURE-REGRESSION GUARD (passed pre-fix): `since` still resolves to `sinceTs`', () => {
    const props = inputSchema().properties ?? {};
    const accepted = Object.keys(props);
    // Both shapes a caller plausibly sends. Neither may lose the suggestion:
    // value-admissibility filtering must not refute a bounded integer schema.
    expect(suggestArgName('since', accepted, { value: MS_VALUE, props })).toBe('sinceTs');
    expect(suggestArgName('since', accepted, { value: '2026-08-01', props })).toBe('sinceTs');
  });

  it('NEGATIVE CONTROL: an unrelated key gets no suggestion', () => {
    // Proves the guard above is discriminating rather than a function that
    // returns `sinceTs` for anything.
    const props = inputSchema().properties ?? {};
    expect(suggestArgName('zzzzqqq', Object.keys(props), { value: 1, props })).toBeNull();
  });
});
