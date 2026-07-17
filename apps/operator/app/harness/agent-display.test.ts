import { describe, expect, it } from 'vitest';
import { lexiconFor } from '@papercusp/lexicon';

import { agentDisplayLabel, agentRoleLabel, agentTermKey } from './agent-display';

const classic = lexiconFor('classic');
const hive = lexiconFor('the-hive');

describe('agent display terminology', () => {
  it.each([
    ['mug', 'brain'],
    ['queen', 'brain'],
    ['papercup', 'operator'],
    ['sentinel', 'operator'],
    ['kettle', 'overwatch'],
    ['overwatch', 'overwatch'],
    ['blender', 'scout'],
    ['scout', 'scout'],
    ['scanner', 'scout'],
    ['cup', 'contributor'],
    ['bee', 'contributor'],
  ] as const)('maps the historical %s id to %s', (alias, term) => {
    expect(agentTermKey(alias)).toBe(term);
  });

  it('renders historical role ids in the public cup vocabulary', () => {
    expect(agentRoleLabel('queen', classic)).toBe('Mug');
    expect(agentRoleLabel('overwatch', classic)).toBe('Kettle');
    expect(agentRoleLabel('scout', classic)).toBe('Blender');
    expect(agentRoleLabel('bee', classic)).toBe('Cup');
  });

  it('continues to honor the opt-in bee vocabulary', () => {
    expect(agentRoleLabel('mug', hive)).toBe('Queen');
    expect(agentRoleLabel('kettle', hive)).toBe('Overwatch');
    expect(agentRoleLabel('blender', hive)).toBe('Scout');
    expect(agentRoleLabel('cup', hive)).toBe('Bee');
  });

  it('normalizes historical aliases inside generated session labels', () => {
    expect(agentDisplayLabel('overwatch · papercusp/kettle', classic)).toBe(
      'Kettle · papercusp/Kettle',
    );
    expect(agentDisplayLabel('queen · papercusp/bee', classic)).toBe(
      'Mug · papercusp/Cup',
    );
  });

  it('does not rewrite arbitrary names or unknown custom roles', () => {
    expect(agentDisplayLabel('Queen of QA', classic)).toBe('Queen of QA');
    expect(agentRoleLabel('doc-steward', classic)).toBe('doc-steward');
  });
});
