import { describe, it, expect } from 'vitest';
import { parsePromotePolicy, getPromotePolicy, extractPromoteSection } from './promote-policy';

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
