/**
 * plans:set-title — pure coverage for the title normalization and read helpers.
 * The handler's lock/revision/invalidation wiring follows the established
 * plans:set-initiative and plans:transfer-owner pattern.
 */
import { describe, expect, it } from 'vitest';
import { currentPlanTitle, normalizePlanTitle } from './set-title';

describe('normalizePlanTitle', () => {
  it('trims and collapses internal whitespace/newlines to a single line', () => {
    expect(normalizePlanTitle('  New   plan\nname  ')).toBe('New plan name');
  });

  it('preserves ordinary title punctuation', () => {
    expect(normalizePlanTitle('Ship v2: owner-safe rename')).toBe('Ship v2: owner-safe rename');
  });

  it('returns an empty string for whitespace-only input for the schema to reject', () => {
    expect(normalizePlanTitle(' \n\t ')).toBe('');
  });
});

describe('currentPlanTitle', () => {
  const fm = (line: string) => `---\ntitle: Existing\nslug: plan-a\nstatus: ready\n${line}\n---\n\n# body\n`;

  it('reads the existing title', () => {
    expect(currentPlanTitle(fm('owner: owner@example.com'))).toBe('Existing');
  });

  it('returns null when the title is absent or blank', () => {
    expect(currentPlanTitle('---\nslug: plan-a\nstatus: ready\n---\n\n# body\n')).toBeNull();
    expect(currentPlanTitle('---\ntitle:\nslug: plan-a\nstatus: ready\n---\n\n# body\n')).toBeNull();
  });
});
