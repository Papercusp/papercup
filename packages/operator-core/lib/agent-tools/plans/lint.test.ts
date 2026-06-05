import { describe, it, expect } from 'vitest';
import { lintParsed } from './lint';
import { parsePlan } from './parser';

/**
 * P-002 (promote-spawn-child-harness): `plans:lint` emits a soft WARNING (never
 * an error) when a `## Promote` wave declares `spawn_child`, and a sharper
 * warning when the child's target tree is ambiguous (no repo + no template).
 *
 * `lintParsed` also runs a PG-backed `## Promoted`-block check, but it fails
 * open to 0 when PG is unreachable, so these stay pure unit tests (no DB).
 */

const planWith = (promoteSection: string) =>
  `---\n` +
  `title: T\n` +
  `slug: spawn-lint-test\n` +
  `status: active\n` +
  `created: 2026-06-05\n` +
  `---\n\n` +
  `# T\n\n` +
  `## Now\n\n**State:** x\n\n**Next:** y\n\n` +
  `## Phase 1\n\n- **P-001** \`todo\` do a thing\n\n` +
  `${promoteSection}\n\n` +
  `## Decisions\n\n### D-001 — a decision\nBody.\n`;

const promoteYaml = (wavesBody: string, target = 'target_harness: restart\n') =>
  '## Promote\n\n```yaml\n' + target + 'waves:\n' + wavesBody + '```';

const lint = async (raw: string) => {
  const parsed = parsePlan(raw);
  return lintParsed(parsed, 'spawn-lint-test', false);
};

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe('plans:lint — spawn_child waves (P-002)', () => {
  it('warns (never errors) on a spawn_child wave, sharper warning when no repo/template', async () => {
    const raw = planWith(
      promoteYaml(
        '  - id: tier1\n' +
          '    spawn_child:\n' +
          '      slug: my-child\n' +
          '    features:\n' +
          '      - title: "Child work"\n',
      ),
    );
    const report = await lint(raw);

    // Both spawn_child findings are WARNINGS — nothing escalates to error.
    expect(codes(report.warnings)).toContain('spawn_child_wave');
    expect(codes(report.warnings)).toContain('spawn_child_ambiguous_target');
    expect(codes(report.errors).filter((c) => c.startsWith('spawn_child'))).toEqual([]);

    const w = report.warnings.find((f) => f.code === 'spawn_child_wave')!;
    expect(w.message).toMatch(/my-child/);
    expect(w.message).toMatch(/D-001/);
  });

  it('a spawn_child wave WITH a template → boundary warning but NOT the ambiguous-target one', async () => {
    const raw = planWith(
      promoteYaml(
        '  - id: tier1\n' +
          '    spawn_child:\n' +
          '      slug: my-child\n' +
          '      template: coding\n' +
          '    features:\n' +
          '      - title: "Child work"\n',
      ),
    );
    const report = await lint(raw);
    expect(codes(report.warnings)).toContain('spawn_child_wave');
    expect(codes(report.warnings)).not.toContain('spawn_child_ambiguous_target');
  });

  it('a spawn_child wave WITH a repo → boundary warning but NOT the ambiguous-target one', async () => {
    const raw = planWith(
      promoteYaml(
        '  - id: tier1\n' +
          '    spawn_child:\n' +
          '      slug: my-child\n' +
          '      repo: https://github.com/acme/widget\n' +
          '    features:\n' +
          '      - title: "Child work"\n',
      ),
    );
    const report = await lint(raw);
    expect(codes(report.warnings)).toContain('spawn_child_wave');
    expect(codes(report.warnings)).not.toContain('spawn_child_ambiguous_target');
  });

  it('one warning per spawn_child wave', async () => {
    const raw = planWith(
      promoteYaml(
        '  - id: a\n' +
          '    spawn_child: {slug: child-a, template: coding}\n' +
          '    features: [{title: x}]\n' +
          '  - id: b\n' +
          '    spawn_child: {slug: child-b, template: coding}\n' +
          '    features: [{title: y}]\n',
      ),
    );
    const report = await lint(raw);
    expect(codes(report.warnings).filter((c) => c === 'spawn_child_wave')).toHaveLength(2);
  });

  it('a plain promote wave (no spawn_child) → no spawn_child findings', async () => {
    const raw = planWith(
      promoteYaml('  - id: tier1\n    features:\n      - title: "Ordinary"\n'),
    );
    const report = await lint(raw);
    expect(codes(report.warnings).some((c) => c.startsWith('spawn_child'))).toBe(false);
    expect(codes(report.errors).some((c) => c.startsWith('spawn_child'))).toBe(false);
  });

  it('a plan with NO ## Promote section → no spawn_child findings, no crash', async () => {
    const raw = planWith('## Background\n\nnothing to promote');
    const report = await lint(raw);
    expect(codes(report.warnings).some((c) => c.startsWith('spawn_child'))).toBe(false);
  });

  it('a MALFORMED promote block (null policy) → no spawn_child findings, no crash', async () => {
    // duplicate spawn_child slug → policy fails to parse → null → lint stays quiet
    const raw = planWith(
      promoteYaml(
        '  - id: a\n    spawn_child: {slug: dupe}\n    features: [{title: x}]\n' +
          '  - id: b\n    spawn_child: {slug: dupe}\n    features: [{title: y}]\n',
      ),
    );
    const report = await lint(raw);
    expect(codes(report.warnings).some((c) => c.startsWith('spawn_child'))).toBe(false);
  });
});
