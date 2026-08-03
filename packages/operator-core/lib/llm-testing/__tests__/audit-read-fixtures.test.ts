/**
 * audit-read-fixtures.test.ts — the SU-S08 read gate's two encoding arms.
 *
 * SU-S08 asks whether the model reads a specific CELL out of a compact row body
 * correctly. EI-136 measured that it does so ~1/3 WRONG when the body is
 * headerless CSV (the column order lives only in the prompt legend, thousands of
 * tokens away) and production therefore moved `audit:list` to self-describing
 * TOON, whose row header names the fields inline.
 *
 * That comparison is only valid if the two arms differ in ENCODING ALONE. If a
 * later edit changes the data in one arm — reorders the rows, renames an actor,
 * moves `locks:acquire` — the scenario keeps passing while silently measuring
 * something else, and the A/B becomes a fixture artifact rather than a
 * measurement. These tests pin that invariant.
 *
 * Run: cd packages/operator-core && npx vitest run lib/llm-testing/__tests__/audit-read-fixtures.test.ts
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_CSV_RESULT, AUDIT_TOON_RESULT, AUDIT_S08_ROWS } from '../scenarios/su/_overrides';

type Row = { id: string; ts: string; actor: string; action: string; subject: string };

/** Pull the wire text a fixture would hand the model for `audit:list`. */
function wireText(override: { override: (name: string, args: unknown) => unknown }): string {
  const r = override.override('audit:list', {}) as { content?: Array<{ text?: string }> };
  const text = r?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('fixture did not return a text result for audit:list');
  return text;
}

/** TOON quotes a value containing `:`; CSV here does not. Normalize both. */
function unquote(v: string): string {
  const t = v.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * Parse the VALUE rows out of either arm. Deliberately shape-agnostic: skip the
 * `format:` marker and whatever header line the encoding uses, then read the
 * remaining comma-separated lines. This is what the MODEL has to do, so parsing
 * it the same way is the point.
 */
function parseRows(text: string): Row[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('format:') && !l.startsWith('['))
    .map((line) => {
      const c = line.split(',').map(unquote);
      return { id: c[0], ts: c[1], actor: c[2], action: c[3], subject: c[4] };
    });
}

const EXPECTED: Row[] = AUDIT_S08_ROWS.map((r) => ({
  id: r.id,
  ts: String(r.ts),
  actor: r.actor,
  action: r.action,
  subject: r.subject,
}));

describe('SU-S08 audit:list read fixtures — the two encoding arms', () => {
  it('the TOON arm (shipped) carries exactly the shared rows', () => {
    expect(parseRows(wireText(AUDIT_TOON_RESULT))).toEqual(EXPECTED);
  });

  it('the CSV arm (historical) carries exactly the shared rows', () => {
    // The CSV literal is hand-maintained (it was verified byte-faithful against
    // a live wire sample), so this is the guard that keeps it in step with
    // AUDIT_S08_ROWS rather than drifting into a different measurement.
    expect(parseRows(wireText(AUDIT_CSV_RESULT))).toEqual(EXPECTED);
  });

  it('the arms differ in ENCODING ONLY — identical data, different bytes', () => {
    const toon = wireText(AUDIT_TOON_RESULT);
    const csv = wireText(AUDIT_CSV_RESULT);
    expect(parseRows(toon)).toEqual(parseRows(csv));
    expect(toon).not.toEqual(csv);
  });

  it('only the TOON arm names its columns inline — the property EI-136 turns on', () => {
    const toon = wireText(AUDIT_TOON_RESULT);
    const csv = wireText(AUDIT_CSV_RESULT);
    // Self-description: the field names ride WITH the data, so no legend lookup.
    expect(toon).toContain('format: toon');
    expect(toon).toContain('{id,ts,actor,action,subject}');
    // The falsifier: the headerless arm gives the reader a bare row count and
    // nothing else. If this ever starts containing the column names, the two
    // arms have collapsed into one and the A/B no longer discriminates.
    expect(csv).toContain('format: csv');
    expect(csv).not.toContain('{id,ts,actor,action,subject}');
    expect(csv).toContain('[3]');
  });

  it('keeps the answer unambiguous: one locks:acquire row, unique actor, distinct decoys', () => {
    // The gate's question ("who acquired the lock?") is only well-posed if
    // exactly one row matches and the other two actors differ from the answer.
    const rows = parseRows(wireText(AUDIT_TOON_RESULT));
    const matches = rows.filter((r) => r.action === 'locks:acquire');
    expect(matches).toHaveLength(1);
    expect(matches[0].actor).toBe('bob');
    const decoys = rows.filter((r) => r.action !== 'locks:acquire').map((r) => r.actor);
    expect(decoys).toEqual(['alice', 'carol']);
    expect(decoys).not.toContain('bob');
  });
});
