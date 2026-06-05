import { describe, it, expect } from 'vitest';
import {
  parsePromotePolicy,
  getPromotePolicy,
  extractPromoteSection,
  buildWaveFeatures,
  applyInterWaveEdges,
  type PromoteWave,
  type BuiltFeature,
} from './promote-policy';

const wrap = (promoteSection: string) =>
  `---\ntitle: T\nslug: t\nstatus: active\n---\n\n# T\n\n## Now\n\n**State:** x\n\n${promoteSection}\n\n## Decisions\n`;

const STATIC = wrap(
  '## Promote\n\n```yaml\n' +
    'target_harness: restart\n' +
    'waves:\n' +
    '  - id: tier1\n' +
    '    features:\n' +
    '      - title: "Fix fetchers"\n' +
    '        from_items: [P-001]\n' +
    '        assigned_role: worker\n' +
    '```',
);

const GENERATIVE = wrap(
  '## Promote\n\n```yaml\n' +
    'target_harness: restart\n' +
    'waves:\n' +
    '  - id: tier1\n' +
    '    features:\n' +
    '      - title: "Build matrix + type axis"\n' +
    '  - id: tier2\n' +
    '    blocked_by: tier1\n' +
    '    generate:\n' +
    '      for_each: universal_type\n' +
    '      feature_template:\n' +
    '        title: "Universal schema: {item}"\n' +
    '        acceptance: ["validates vs asinDetails for {item}"]\n' +
    '```',
);

describe('parsePromotePolicy', () => {
  it('parses a static-only wave', () => {
    const { policy, warnings } = parsePromotePolicy(STATIC);
    expect(warnings).toEqual([]);
    expect(policy?.target_harness).toBe('restart');
    expect(policy?.waves).toHaveLength(1);
    expect(policy?.waves[0].id).toBe('tier1');
    expect(policy?.waves[0].features?.[0]).toMatchObject({
      title: 'Fix fetchers',
      from_items: ['P-001'],
      assigned_role: 'worker',
    });
  });

  it('parses a generative wave with blocked_by + a placeholder template', () => {
    const { policy, warnings } = parsePromotePolicy(GENERATIVE);
    expect(warnings).toEqual([]);
    expect(policy?.waves).toHaveLength(2);
    const t2 = policy!.waves[1];
    expect(t2.id).toBe('tier2');
    expect(t2.blocked_by).toBe('tier1');
    expect(t2.generate?.for_each).toBe('universal_type');
    expect(t2.generate?.feature_template.title).toBe('Universal schema: {item}'); // placeholder preserved
  });

  it('returns null + no warning when there is no ## Promote section', () => {
    const { policy, warnings } = parsePromotePolicy(wrap('## Background\n\nnothing here'));
    expect(policy).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('parses an unfenced YAML body and a JSON fenced body', () => {
    const unfenced = wrap('## Promote\n\nwaves:\n  - id: w1\n    features:\n      - title: A\n');
    expect(getPromotePolicy(unfenced)?.waves[0].features?.[0].title).toBe('A');

    const json = wrap('## Promote\n\n```json\n{"waves":[{"id":"w1","features":[{"title":"B"}]}]}\n```');
    expect(getPromotePolicy(json)?.waves[0].features?.[0].title).toBe('B');
  });

  it('a wave with neither features nor generate → null + warning (no throw)', () => {
    const bad = wrap('## Promote\n\n```yaml\nwaves:\n  - id: empty\n```');
    const { policy, warnings } = parsePromotePolicy(bad);
    expect(policy).toBeNull();
    expect(warnings.join(' ')).toMatch(/features\[\] and\/or generate/);
  });

  it('duplicate wave id and unknown blocked_by → warnings', () => {
    const dup = wrap(
      '## Promote\n\n```yaml\nwaves:\n  - id: a\n    features: [{title: x}]\n  - id: a\n    features: [{title: y}]\n```',
    );
    expect(parsePromotePolicy(dup).warnings.join(' ')).toMatch(/duplicate wave id: a/);

    const badRef = wrap(
      '## Promote\n\n```yaml\nwaves:\n  - id: a\n    blocked_by: ghost\n    features: [{title: x}]\n```',
    );
    expect(parsePromotePolicy(badRef).warnings.join(' ')).toMatch(/blocked_by unknown wave: ghost/);
  });

  it('malformed YAML → null + warning, never throws', () => {
    const broken = wrap('## Promote\n\n```yaml\nwaves: [ { id: a,, } \n```');
    const { policy, warnings } = parsePromotePolicy(broken);
    expect(policy).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('extractPromoteSection handles a numbered heading', () => {
    const numbered = wrap('## 9a. Promote\n\n```yaml\nwaves:\n  - id: w\n    features: [{title: Z}]\n```');
    expect(extractPromoteSection(numbered)).not.toBeNull();
    expect(getPromotePolicy(numbered)?.waves[0].features?.[0].title).toBe('Z');
  });
});

describe('parsePromotePolicy — spawn_child (P-001)', () => {
  const spawnChild = (extra: string, target = 'target_harness: restart\n') =>
    wrap(
      '## Promote\n\n```yaml\n' +
        target +
        'waves:\n' +
        '  - id: tier1\n' +
        '    spawn_child:\n' +
        '      slug: my-child\n' +
        extra +
        '    features:\n' +
        '      - title: "Child work"\n' +
        '```',
    );

  it('parses a valid spawn_child wave with all fields', () => {
    const { policy, warnings } = parsePromotePolicy(
      spawnChild(
        '      template: coding\n' +
          '      repo: https://github.com/acme/widget\n' +
          '      goal: "Build the widget"\n',
      ),
    );
    expect(warnings).toEqual([]);
    expect(policy?.waves[0].spawn_child).toEqual({
      slug: 'my-child',
      template: 'coding',
      repo: 'https://github.com/acme/widget',
      goal: 'Build the widget',
    });
  });

  it('parses a minimal spawn_child wave (slug only)', () => {
    const { policy, warnings } = parsePromotePolicy(spawnChild(''));
    expect(warnings).toEqual([]);
    expect(policy?.waves[0].spawn_child?.slug).toBe('my-child');
    expect(policy?.waves[0].spawn_child?.template).toBeUndefined();
  });

  it('a wave WITHOUT spawn_child still parses identically (additive)', () => {
    const { policy, warnings } = parsePromotePolicy(STATIC);
    expect(warnings).toEqual([]);
    expect(policy?.waves[0].spawn_child).toBeUndefined();
  });

  it('a bad slug → null + warning, never throws (fail-safe)', () => {
    expect(() => parsePromotePolicy(spawnChild('', 'target_harness: restart\n'))).not.toThrow();
    const bad = wrap(
      '## Promote\n\n```yaml\n' +
        'waves:\n' +
        '  - id: t1\n' +
        '    spawn_child:\n' +
        '      slug: "Bad_Slug!"\n' +
        '    features: [{title: x}]\n' +
        '```',
    );
    const { policy, warnings } = parsePromotePolicy(bad);
    expect(policy).toBeNull();
    expect(warnings.join(' ')).toMatch(/kebab-case/);
  });

  it('a spawn_child wave with NO features/generate still fails the wave refine', () => {
    const bad = wrap(
      '## Promote\n\n```yaml\n' +
        'waves:\n' +
        '  - id: t1\n' +
        '    spawn_child:\n' +
        '      slug: my-child\n' +
        '```',
    );
    const { policy, warnings } = parsePromotePolicy(bad);
    expect(policy).toBeNull();
    expect(warnings.join(' ')).toMatch(/features\[\] and\/or generate/);
  });

  it('an unknown spawn_child key (typo) → null + warning (.strict)', () => {
    const typo = wrap(
      '## Promote\n\n```yaml\n' +
        'waves:\n' +
        '  - id: t1\n' +
        '    spawn_child:\n' +
        '      slug: my-child\n' +
        '      tempate: coding\n' + // typo'd `template`
        '    features: [{title: x}]\n' +
        '```',
    );
    const { policy, warnings } = parsePromotePolicy(typo);
    expect(policy).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('duplicate spawn_child slug across waves → null + warning', () => {
    const dup = wrap(
      '## Promote\n\n```yaml\n' +
        'waves:\n' +
        '  - id: a\n' +
        '    spawn_child: {slug: dupe}\n' +
        '    features: [{title: x}]\n' +
        '  - id: b\n' +
        '    spawn_child: {slug: dupe}\n' +
        '    features: [{title: y}]\n' +
        '```',
    );
    const { policy, warnings } = parsePromotePolicy(dup);
    expect(policy).toBeNull();
    expect(warnings.join(' ')).toMatch(/duplicate spawn_child slug: dupe/);
  });

  it('spawn_child slug equal to target_harness → null + warning', () => {
    const clash = wrap(
      '## Promote\n\n```yaml\n' +
        'target_harness: restart\n' +
        'waves:\n' +
        '  - id: a\n' +
        '    spawn_child: {slug: restart}\n' +
        '    features: [{title: x}]\n' +
        '```',
    );
    const { policy, warnings } = parsePromotePolicy(clash);
    expect(policy).toBeNull();
    expect(warnings.join(' ')).toMatch(/must differ from target_harness/);
  });
});

describe('buildWaveFeatures', () => {
  it('returns static features verbatim (no warnings)', () => {
    const wave: PromoteWave = {
      id: 'tier1',
      features: [{ title: 'Fix fetchers', from_items: ['P-001'], assigned_role: 'worker' }],
    };
    const r = buildWaveFeatures(wave);
    expect(r.warnings).toEqual([]);
    expect(r.features).toEqual([{ title: 'Fix fetchers', from_items: ['P-001'], assigned_role: 'worker' }]);
  });

  it('expands a generative template once per generateItems, substituting {item}', () => {
    const wave: PromoteWave = {
      id: 'tier2',
      generate: {
        for_each: 'universal_type',
        feature_template: {
          title: 'Universal schema: {item}',
          acceptance: ['validates vs asinDetails for {item}'],
          assigned_role: 'worker',
          agent_hint: 'row-grain for {item}',
        },
      },
    };
    const r = buildWaveFeatures(wave, { generateItems: ['LAPTOP', 'CAMERA'] });
    expect(r.warnings).toEqual([]);
    expect(r.features.map((f) => f.title)).toEqual(['Universal schema: LAPTOP', 'Universal schema: CAMERA']);
    expect(r.features[0].acceptance).toEqual(['validates vs asinDetails for LAPTOP']);
    expect(r.features[0].assigned_role).toBe('worker');
    expect(r.features[1].body).toContain('Hint: row-grain for CAMERA'); // agent_hint folded into body
    expect(r.features[0].from_items).toBeUndefined(); // generated features aren't plan items
  });

  it('a generative wave with no generateItems → warning + no generated features', () => {
    const wave: PromoteWave = {
      id: 'tier2',
      generate: { for_each: 'universal_type', feature_template: { title: 'X: {item}' } },
    };
    const r = buildWaveFeatures(wave);
    expect(r.features).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/generative.*no generateItems/);
  });

  it('a mixed wave yields static + generated features', () => {
    const wave: PromoteWave = {
      id: 'mix',
      features: [{ title: 'static one' }],
      generate: { for_each: 'thing', feature_template: { title: 'gen {item}' } },
    };
    const r = buildWaveFeatures(wave, { generateItems: ['A'] });
    expect(r.features.map((f) => f.title)).toEqual(['static one', 'gen A']);
  });

  it('P-001: stamps spawn_child_slug on every built feature (static + generated)', () => {
    const wave: PromoteWave = {
      id: 'mix',
      spawn_child: { slug: 'my-child' },
      features: [{ title: 'static one' }],
      generate: { for_each: 'thing', feature_template: { title: 'gen {item}' } },
    };
    const r = buildWaveFeatures(wave, { generateItems: ['A'] });
    expect(r.features.map((f) => f.spawn_child_slug)).toEqual(['my-child', 'my-child']);
  });

  it('P-001: a wave WITHOUT spawn_child leaves spawn_child_slug undefined', () => {
    const wave: PromoteWave = { id: 'plain', features: [{ title: 'x' }] };
    const r = buildWaveFeatures(wave);
    expect(r.features[0].spawn_child_slug).toBeUndefined();
  });
});

describe('applyInterWaveEdges — cross-wave ordering as feature blocked_by (P-044)', () => {
  const waves: PromoteWave[] = [
    { id: 'w1' },
    { id: 'w2', blocked_by: 'w1' },
    { id: 'w3', blocked_by: 'w2' },
  ];
  const make = (): Map<string, BuiltFeature[]> =>
    new Map([
      ['w1', [{ title: 'A' }, { title: 'B' }]],
      ['w2', [{ title: 'C' }]],
      ['w3', [{ title: 'D', blocked_by: ['C'] }]],
    ]);

  it('blocks every feature of a wave by every feature title of its prior wave', () => {
    const m = make();
    applyInterWaveEdges(waves, m);
    expect(m.get('w2')![0].blocked_by!.sort()).toEqual(['A', 'B']);
  });

  it('merges with a feature\'s own blocked_by and dedupes', () => {
    const m = make();
    applyInterWaveEdges(waves, m);
    // w3/D already had blocked_by [C] (its prior wave's only feature) — no dup.
    expect(m.get('w3')![0].blocked_by).toEqual(['C']);
  });

  it('leaves the first (unblocked) wave untouched', () => {
    const m = make();
    applyInterWaveEdges(waves, m);
    expect(m.get('w1')!.every((f) => !f.blocked_by)).toBe(true);
  });

  it('is a no-op when a wave has no blocked_by', () => {
    const m = new Map<string, BuiltFeature[]>([['w1', [{ title: 'A' }]]]);
    applyInterWaveEdges([{ id: 'w1' }], m);
    expect(m.get('w1')![0].blocked_by).toBeUndefined();
  });
});
