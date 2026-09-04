/**
 * persona-tier.test.ts — the FLEET persona tier (context-trimming-tiers
 * P-017): FULL-ONLY tag stripping, the compact fleet AUTO clause, and the
 * tier threading through renderSuPlaybook over a synthetic base (hermetic —
 * no real prompts dir).
 *
 * Run: cd packages/operator-core && npx vitest run lib/desktop-install/persona-tier.test.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLAYBOOK_FULL_ONLY_BEGIN,
  PLAYBOOK_FULL_ONLY_END,
  renderSuPlaybook,
  stripFullOnlySections,
} from './papercusp-files';
import { renderModesPolicy } from '../operating-modes-policy';

describe('stripFullOnlySections (P-017)', () => {
  it('removes tagged blocks and keeps everything else', () => {
    const text = [
      'keep-1',
      PLAYBOOK_FULL_ONLY_BEGIN,
      'drop-1',
      PLAYBOOK_FULL_ONLY_END,
      'keep-2',
      PLAYBOOK_FULL_ONLY_BEGIN,
      'drop-2',
      PLAYBOOK_FULL_ONLY_END,
      'keep-3',
    ].join('\n');
    const out = stripFullOnlySections(text);
    expect(out).toContain('keep-1');
    expect(out).toContain('keep-2');
    expect(out).toContain('keep-3');
    expect(out).not.toContain('drop-1');
    expect(out).not.toContain('drop-2');
    expect(out).not.toContain('FULL-ONLY');
  });

  it('fails soft on an unbalanced BEGIN (never truncates the tail)', () => {
    const text = `keep\n${PLAYBOOK_FULL_ONLY_BEGIN}\nrest stays because no END`;
    expect(stripFullOnlySections(text)).toBe(text);
  });
});

describe('renderModesPolicy tiers (P-017 → P-021)', () => {
  it('both tiers render the same KERNEL stub — the definitions are identity layers bound by registry state, not by tier', () => {
    const full = renderModesPolicy();
    const fleet = renderModesPolicy('fleet');
    expect(fleet).toBe(full);
    expect(full).toContain('## Operating modes');
    expect(full).not.toContain('## AUTO mode — the owner\'s switch');
    expect(full).not.toContain('## AUTO mode — you are in it');
    expect(full).not.toContain('## IDEATE mode');
  });
});

describe('renderSuPlaybook tier threading (P-017)', () => {
  let dir: string;
  let baseSource: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'persona-tier-'));
    baseSource = join(dir, 'papercusp-su-engineer.tools.md');
    await writeFile(
      baseSource,
      [
        '# Synthetic base',
        '## Spine section',
        'coordination discipline stays',
        PLAYBOOK_FULL_ONLY_BEGIN,
        '## Leader-only section',
        'route menu / desktop-fleet spawning prose',
        PLAYBOOK_FULL_ONLY_END,
        '<!-- PAPERCUSP-SU:AUTO-MODE -->',
        '',
      ].join('\n'),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('full keeps tags inert (content present); fleet strips them + compacts AUTO', async () => {
    const full = await renderSuPlaybook({ agent: 'claude', baseSource, projectGuideSource: '' });
    expect(full.text).toContain('Leader-only section');
    expect(full.text).toContain('## IDEATE mode');
    const fleet = await renderSuPlaybook({
      agent: 'claude',
      baseSource,
      projectGuideSource: '',
      tier: 'fleet',
    });
    expect(fleet.text).toContain('Spine section');
    expect(fleet.text).not.toContain('Leader-only section');
    expect(fleet.text).not.toContain('IDEATE');
    expect(fleet.text).toContain('## AUTO mode — you are in it');
    expect(fleet.text).not.toContain('FULL-ONLY');
  });
});
