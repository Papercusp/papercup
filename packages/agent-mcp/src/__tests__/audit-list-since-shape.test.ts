/**
 * EI-20216014898419956 — `audit:list` takes `sinceTs` while neighbouring
 * time-filter tools take `since`.
 *
 * The item offered two remedies: (a) accept `since` as an alias, or (b) make
 * the millisecond-integer shape discoverable before rejection. Measuring
 * first showed (a) was ALREADY delivered — tooldef's edit-distance rung
 * resolves `since` -> `sinceTs` (distance 2, threshold 2) — so only (b) was
 * real work. These tests pin both halves, and they are deliberately NOT of
 * equal evidentiary weight:
 *
 *   - The `describe()` case DISCRIMINATES: it fails against the pre-fix
 *     source, where `sinceTs` rendered as a bare `{type:'integer'}`.
 *   - The did-you-mean case is a FUTURE-REGRESSION guard only. It passed
 *     before the change too, because that rung already worked. It is here so
 *     that a later edit to `ARG_TYPE_SUFFIXES`, the threshold formula, or the
 *     accepted-key set cannot silently take the name half away again.
 *
 * Do not read the second case as evidence for the fix; it is a latch, not a
 * measurement.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
// The `./define-tool` subpath, not the barrel: `suggestArgName` is exported
// from define-tool.ts but deliberately not re-exported by src/index.ts.
import { suggestArgName } from '@papercusp/tooldef/define-tool';
import auditList from '../tools/audit/list';

/**
 * Render the tool's own declared schema the way a caller sees it.
 *
 * Must be zod's own `z.toJSONSchema(..., { io: 'input' })`. The
 * `zodToJsonSchema` package returns a bare `{ $schema }` for zod 4 (this repo
 * is zod 4.x), which makes subject AND control both come back empty and reads
 * like a real finding instead of a dead instrument.
 */
function inputSchema(): { properties?: Record<string, { description?: string }> } {
  const args = (auditList as unknown as { args: z.ZodType }).args;
  return z.toJSONSchema(args, { io: 'input' }) as ReturnType<typeof inputSchema>;
}

describe('audit:list sinceTs shape (EI-20216014898419956)', () => {
  it('CONTROL: the rendered schema is non-empty, so an absent description is a real absence', () => {
    // Without this, a broken renderer would make every assertion below vacuous.
    const props = inputSchema().properties ?? {};
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['detail', 'actor', 'action', 'sinceTs', 'limit', 'workspace']),
    );
  });

  it('DISCRIMINATING: sinceTs declares its unit as epoch milliseconds', () => {
    const description = inputSchema().properties?.sinceTs?.description ?? '';
    expect(description).not.toEqual('');
    expect(description).toMatch(/millisecond/i);
  });

  it('DISCRIMINATING: sinceTs warns that epoch SECONDS is accepted rather than rejected', () => {
    // The load-bearing half. A seconds value is a valid integer, so it passes
    // validation and then matches essentially every row — a wrong unit yields a
    // full result set, not an error. A description naming only "milliseconds"
    // would leave that silent-failure mode undocumented.
    const description = inputSchema().properties?.sinceTs?.description ?? '';
    expect(description).toMatch(/second/i);
  });

  it('FUTURE-REGRESSION GUARD (passed pre-fix): `since` still resolves to `sinceTs`', () => {
    const props = inputSchema().properties ?? {};
    const accepted = Object.keys(props);
    // Both shapes a caller plausibly sends. Neither may lose the suggestion:
    // value-admissibility filtering must not refute a plain integer schema.
    expect(suggestArgName('since', accepted, { value: 1788000000000, props })).toBe('sinceTs');
    expect(suggestArgName('since', accepted, { value: '2026-08-01', props })).toBe('sinceTs');
  });

  it('NEGATIVE CONTROL: an unrelated key gets no suggestion', () => {
    // Proves the guard above is discriminating rather than a function that
    // returns `sinceTs` for anything.
    const props = inputSchema().properties ?? {};
    expect(suggestArgName('zzzzqqq', Object.keys(props), { value: 1, props })).toBeNull();
  });
});
