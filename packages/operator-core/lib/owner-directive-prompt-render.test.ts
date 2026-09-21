/**
 * Recurrence guard for WI-10002186.
 *
 * The hybrid capture contract must survive the actual SU prompt assembler, not
 * merely exist in an un-rendered source file. This pins the live blueprint
 * `su.md` path and asks renderSuPlaybook for the same deterministic composition
 * used by a new interactive session.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSuPlaybook } from './desktop-install/papercusp-files';

const REPO_ROOT = join(fileURLToPath(new URL('../../../', import.meta.url)));
const BLUEPRINT_SU = join(
  REPO_ROOT,
  'libs',
  'papercusp',
  'packages',
  'harness',
  'blueprints',
  'base',
  'prompts',
  'su.md',
);
const OPERATOR_PROMPTS = join(REPO_ROOT, 'apps', 'operator', 'prompts');

describe('rendered SU persona — hybrid owner-directive capture (WI-10002186)', () => {
  it('keeps capture and next-turn resolution instructions in the live render', async () => {
    const rendered = await renderSuPlaybook({
      agent: 'claude',
      profile: 'engineer',
      baseSource: BLUEPRINT_SU,
      overlayDir: OPERATOR_PROMPTS,
      projectGuideSource: '',
      renderWireSchemas: () => '',
    });

    expect(rendered.baseSource).toBe(BLUEPRINT_SU);
    expect(rendered.text).toContain('## Owner directives — durable capture and resolution');
    expect(rendered.text).toContain('UserPromptSubmit hook records the owner turn verbatim as a PENDING row');
    expect(rendered.text).toContain("orders:resolve-pending { id, action: 'promote' }");
    expect(rendered.text).toContain("orders:resolve-pending { id, action: 'dismiss', reason }");
    expect(rendered.text).toContain("orders:disposition { id, status: 'done'|'declined', note }");
  });
});
