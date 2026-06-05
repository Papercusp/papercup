import { describe, expect, it } from 'vitest';
import { findFuzzyDuplicate, similarity } from './operator-fuzzy-dedup';

describe('similarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(similarity('Run validator', 'Run validator')).toBe(1);
  });

  it('treats case + punctuation as noise', () => {
    expect(similarity('Run validator!', 'run VALIDATOR')).toBeGreaterThan(0.95);
  });

  it('drops below threshold for unrelated titles', () => {
    expect(similarity('Run validator', 'Open Linear board')).toBeLessThan(0.5);
  });
});

describe('findFuzzyDuplicate', () => {
  const existing = [
    { id: 'a', title: 'Run validator on F-001' },
    { id: 'b', title: 'Open Linear board for Sprint 12' },
  ];

  it('matches a paraphrase to its near-duplicate', () => {
    // Same intent, slightly reworded — the "validate F-001" case from §10.
    const m = findFuzzyDuplicate('Run validator on F 001', existing);
    expect(m?.matchedId).toBe('a');
  });

  it('returns null when no candidate clears threshold', () => {
    expect(findFuzzyDuplicate('Schedule team standup', existing)).toBeNull();
  });
});
