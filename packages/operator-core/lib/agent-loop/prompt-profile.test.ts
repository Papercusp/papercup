import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assembleRolePrompt } from '../prompt-assembly';

import {
  PUI_LOOP_PROJECT_GUIDE_MAX_CHARS,
  projectGuideAtBudget,
  renderPuiLoopPrompt,
  resolvePuiLoopProjectDir,
} from './prompt-profile';

const projectDir = resolvePuiLoopProjectDir();

describe('pui-loop prompt profile (D-034 / WI-583183)', () => {
  it('projects the canonical su layers + bounded project guide + tool catalog, without client remediation', async () => {
    const rendered = await renderPuiLoopPrompt({
      projectDir,
      toolNames: [],
      toolCatalogText:
        '## Available tools\n\n- `capability:read`\n  Read a source file through the owned loop door.',
    });

    expect(rendered.text).toContain('# Superuser engineer-collaborator (su)');
    // identities-v1 P-021 / D-024 §3: the AUTO-MODE seam splices the KERNEL stub only
    // (registry-derived, identical on both tiers); the `## AUTO mode` DEFINITION is the
    // `su.mode-auto` identity, bound only when a session REGISTERS auto. The owned loop
    // registers no modes, so its render carries the stub and none of the definitions.
    expect(rendered.text).toContain('## Operating modes — state in the registry, definitions as identity layers');
    expect(rendered.text).not.toContain('## AUTO mode — the owner\'s switch');
    expect(rendered.text).toContain('## Project guide — repo conventions');
    expect(rendered.text).toContain('## Available tools');
    expect(rendered.text).toContain('`capability:read`');
    expect(rendered.projectGuideSource).toBe(join(projectDir, 'CLAUDE.md'));
    expect(rendered.projectGuideTruncated).toBe(false);

    expect(rendered.omittedClientRemediation).toEqual(
      expect.arrayContaining([
        'client-compaction-strategy',
        'client-subagent-denial',
        'client-tool-discovery-workaround',
        'client-bash-preamble-override',
      ]),
    );
    expect(rendered.text).not.toMatch(/ToolSearch|NO_SUBAGENT_TOOLS_DENY/);
    expect(rendered.text).not.toContain('Managing your own compaction');
    expect(rendered.text).not.toContain('While bypass permissions mode is active:');
    expect(rendered.text).not.toMatch(/<!-- PAPERCUSP-SU:[A-Z-]+ -->/);
  });

  it('cuts an oversized guide honestly at the profile budget', () => {
    const source = '/repo/CLAUDE.md';
    const input = `${'guide line\n'.repeat(20_000)}tail sentinel`;
    const out = projectGuideAtBudget(input, source);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(PUI_LOOP_PROJECT_GUIDE_MAX_CHARS + 256);
    expect(out.text).toContain('Project guide truncated by the pui-loop prompt budget');
    expect(out.text).toContain(source);
    expect(out.text).not.toContain('tail sentinel');
  });

  it('applies profile omissions before measuring the project-guide budget', () => {
    const dropped = 'client-only drop sentinel\n'.repeat(40);
    const kept = 'kept repo convention';
    const guideText =
      '# Guide\n\n' +
      '## Reaching for bash? These reads already have a tool\n\n' +
      dropped +
      '\n## Project-specific convention\n\n' +
      kept;
    const maxChars = 128;
    expect(guideText.length).toBeGreaterThan(maxChars);

    const rendered = assembleRolePrompt({
      role: 'operator',
      profile: 'pui-loop',
      projectDir,
      toolNames: [],
      projectGuideText: guideText,
      projectGuideSource: '/repo/CLAUDE.md',
      projectGuideMaxChars: maxChars,
      toolCatalogText: '',
    });

    expect(rendered.projectGuideTruncated).toBe(false);
    expect(rendered.text).toContain(kept);
    expect(rendered.text).not.toContain('client-only drop sentinel');
  });

  it('the live agent-chats route selects this profile only for the owned loop operator seam', () => {
    const route = readFileSync(
      join(projectDir, 'packages/operator-core/lib/endpoint-route/routes/agent-chats/index.ts'),
      'utf8',
    );
    expect(route).toContain("import { assembleRolePrompt as assembleOperatorRolePrompt } from '../../../prompt-assembly'");
    expect(route).toMatch(/chat\.role === 'operator'[\s\S]*useLoopEngine[\s\S]*profile: 'pui-loop'/);
    expect(route).toMatch(/profile: 'pui-loop'[\s\S]*projectDir[\s\S]*toolNames:/);
  });
});
