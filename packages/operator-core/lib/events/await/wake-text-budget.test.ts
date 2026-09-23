import { describe, expect, it } from 'vitest';
import {
  buildOmissionFooter,
  packWakeText,
  recordWakePack,
  renderSectionIndex,
  splitWakeSections,
  wakePackCounters,
} from './wake-text-budget';

// review-system-rework-reduction-2026-09-23 P-024 clause D (absorbed P-026).
const SPILL = '/home/u/.papercusp/wake-spills/su-x/delivery-1.md';

/** An oversized loop-wake-shaped input: headline, a long carry-note, and a Next action last. */
function oversizedWake(paragraphs = 120): string {
  return [
    '🔁 Loop wake #24 — continuing your OWN warm session',
    '## Did',
    ...Array.from({ length: paragraphs }, (_, i) => `Did paragraph ${i}: ${'evidence '.repeat(12)}`),
    '## Left\nP-024 clause D binding.',
    '## Next action\nRun lint:tsc over the changed set.',
  ].join('\n\n');
}

describe('RSR-P-024-D — wake text is built within its budget without truncating after the fact', () => {
  it('never exceeds the budget, across a sweep of budgets', () => {
    const text = oversizedWake();
    for (const budget of [400, 800, 1_500, 3_000, 6_000]) {
      const packed = packWakeText(text, budget, Math.floor(budget / 4), SPILL);
      expect(packed.text.length).toBeLessThanOrEqual(budget);
    }
  });

  it('never cuts mid-section: every delivered section is byte-identical to an original section', () => {
    const text = oversizedWake();
    const originals = new Set(splitWakeSections(text).map((s) => s.text));
    const packed = packWakeText(text, 2_000, 500, SPILL);
    expect(packed.kept.length).toBeGreaterThan(0);
    for (const s of packed.kept) expect(originals.has(s.text)).toBe(true);
    // The delivered body is exactly the kept sections plus the footer — nothing else.
    expect(packed.text).toBe(`${packed.kept.map((s) => s.text).join('\n\n')}\n\n${packed.footer}`);
    expect(packed.text).not.toMatch(/was truncated/);
  });

  it('keeps the headline and the Next action section first, then fills in document order', () => {
    const packed = packWakeText(oversizedWake(), 2_000, 500, SPILL);
    const titles = packed.kept.map((s) => s.title);
    expect(titles[0]).toMatch(/^🔁 Loop wake #24/);
    expect(packed.text).toContain('## Next action\nRun lint:tsc over the changed set.');
    // Order is the ORIGINAL order, not the priority order.
    const idx = packed.kept.map((s) => s.index);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('names every left-out section in the footer, with a pointer to the spill file', () => {
    const packed = packWakeText(oversizedWake(35), 3_600, 900, SPILL);
    expect(packed.omitted.length).toBeGreaterThan(0);
    expect(packed.footer).not.toMatch(/\+\d+ more/);
    expect(packed.footer.startsWith('[injection-door: ')).toBe(true);
    expect(packed.footer).toContain(SPILL);
    expect(packed.footer).toContain(`${packed.omitted.length} section(s) did not fit`);
    for (const s of packed.omitted) expect(packed.footer).toContain(`"${s.title}"`);
    // The footer is ONE [injection-door: …] span, so turn-provenance's lazy regex strips all of it.
    expect(packed.footer.match(/\[injection-door:[\s\S]*?\]/)?.[0]).toBe(packed.footer);
  });

  it('when the names do not fit, counts the rest and the spill index still names every section', () => {
    const packed = packWakeText(oversizedWake(300), 1_200, 300, SPILL);
    expect(packed.text.length).toBeLessThanOrEqual(1_200);
    expect(packed.footer).toMatch(/\+\d+ more/);
    const index = renderSectionIndex(packed);
    for (const s of packed.omitted) expect(index).toContain(`LEFT OUT — "${s.title}"`);
    expect(index.split('\n')).toHaveLength(packed.kept.length + packed.omitted.length);
  });

  it('leaves a single oversized section out whole rather than slicing it', () => {
    const giant = `STALE-SNAPSHOT ${'x'.repeat(10_000)}`;
    const packed = packWakeText(`HEADLINE\n\n${giant}\n\n## Next action\nwait`, 1_000, 250, SPILL);
    expect(packed.text.length).toBeLessThanOrEqual(1_000);
    // Only its 60-char title is quoted in the footer; the section body is not delivered.
    expect(packed.text).not.toContain('x'.repeat(100));
    expect(packed.omitted.map((s) => s.title)).toEqual([expect.stringMatching(/^STALE-SNAPSHOT/)]);
    expect(packed.text.startsWith('HEADLINE')).toBe(true);
  });

  it('passes a within-budget wake through byte-identical', () => {
    const text = 'short wake\n\n\n## Next action\nnone';
    expect(packWakeText(text, 10_000, 2_500, SPILL)).toMatchObject({ text, omitted: [], footer: '' });
  });

  it('attaches a bare heading to the paragraph after it and strips ] and " from footer titles', () => {
    const sections = splitWakeSections('intro\n\n## Did\n\nfirst "quoted] line"\n\nsecond');
    expect(sections.map((s) => s.title)).toEqual(['intro', '## Did', '## Did ¶2']);
    expect(sections[1]!.text).toBe('## Did\nfirst "quoted] line"');
    const footer = buildOmissionFooter([{ index: 0, title: splitWakeSections('a "b] c')[0]!.title, text: 'x' }], 10, SPILL, 1_000);
    expect(footer.indexOf(']')).toBe(footer.length - 1);
  });

  it('counts packed wakes and omitted sections (the P-026 counter)', () => {
    const before = wakePackCounters();
    recordWakePack(3);
    recordWakePack(0);
    const after = wakePackCounters();
    expect(after.packedWakes - before.packedWakes).toBe(1);
    expect(after.omittedSections - before.omittedSections).toBe(3);
  });
});
