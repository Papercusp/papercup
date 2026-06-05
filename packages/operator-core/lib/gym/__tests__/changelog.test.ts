import { describe, it, expect } from 'vitest';
import { formatChangelogEntry, appendChangelog, type ChangelogEntry } from '../changelog';

/**
 * Judge running-changelog (P-017). Each cycle appends an entry anchored to HARD
 * numbers (dev-anchor Δ, cost Δ, probe status) + a narrative — fed into the proposer
 * + judge context to avoid dead-ends and detect oscillation. Pure formatting.
 */
const accepted: ChangelogEntry = {
  cycle: 3,
  decision: 'accept',
  devAnchorDelta: 0.42,
  costDelta: -0.1,
  probeCaught: true,
  narrative: 'tightened validator evidence requirement',
};

describe('formatChangelogEntry', () => {
  it('anchors to signed hard numbers + probe status + narrative', () => {
    const line = formatChangelogEntry(accepted);
    expect(line).toContain('cycle 3');
    expect(line).toContain('accept');
    expect(line).toContain('+0.42'); // dev-anchor delta, signed
    expect(line).toContain('-0.10'); // cost delta, signed
    expect(line).toMatch(/probe.*caught/i);
    expect(line).toContain('tightened validator evidence requirement');
  });

  it('flags a missed probe and a reject', () => {
    const line = formatChangelogEntry({ ...accepted, decision: 'reject', probeCaught: false });
    expect(line).toContain('reject');
    expect(line).toMatch(/probe.*miss/i);
  });
});

describe('appendChangelog', () => {
  it('appends to an existing changelog', () => {
    const out = appendChangelog('cycle 1: ...\ncycle 2: ...', accepted);
    expect(out.split('\n')).toHaveLength(3);
    expect(out.endsWith(formatChangelogEntry(accepted))).toBe(true);
  });

  it('returns just the entry when the changelog is empty', () => {
    expect(appendChangelog('', accepted)).toBe(formatChangelogEntry(accepted));
  });
});
