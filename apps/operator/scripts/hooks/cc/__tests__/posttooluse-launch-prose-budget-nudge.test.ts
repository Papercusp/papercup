import { describe, expect, it } from 'vitest';

import {
  findRepoRoot,
  formatNudge,
  isDocPartWrite,
  isLaunchProsePath,
  nudgeFor,
  runBudget,
  shouldCheck,
} from '../posttooluse-launch-prose-budget-nudge.mjs';

describe('posttooluse-launch-prose-budget-nudge', () => {
  it('recognises prompt and projected guide paths, but not ordinary source files', () => {
    expect(isLaunchProsePath('/repo/apps/operator/prompts/papercusp-su.codex.md')).toBe(true);
    expect(isLaunchProsePath('/repo/CLAUDE.md')).toBe(true);
    expect(isLaunchProsePath('/repo/packages/operator-core/lib/foo.ts')).toBe(false);
  });

  it('recognises set-doc-part and projector writes', () => {
    expect(isDocPartWrite('Bash', { command: 'node scripts/set-doc-part.ts --write' })).toBe(true);
    expect(isDocPartWrite('Bash', { command: 'node scripts/project-doc-parts.mjs --write' })).toBe(true);
    expect(isDocPartWrite('Bash', { command: 'node scripts/set-doc-part.ts --show' })).toBe(false);
    expect(isDocPartWrite('docs:author', { write: true })).toBe(false);
  });

  it('checks prompt edits and ignores unrelated edits', () => {
    expect(shouldCheck('Edit', { file_path: '/repo/apps/operator/prompts/foo.md' })).toBe(true);
    expect(shouldCheck('Edit', { file_path: '/repo/packages/foo.ts' })).toBe(false);
    expect(shouldCheck('Edit', { file_path: 'apps/operator/prompts/foo.md' })).toBe(true);
    expect(shouldCheck('apply_patch', '*** Begin Patch\n*** Update File: apps/operator/prompts/foo.md\n@@\n-a\n+b\n*** End Patch')).toBe(true);
    expect(shouldCheck('mcp__papercusp_su__tools_invoke', { name: 'capability:edit', args: { file_path: 'apps/operator/prompts/foo.md' } })).toBe(true);
    expect(shouldCheck('Read', { file_path: '/repo/apps/operator/prompts/foo.md' })).toBe(false);
  });

  it('formats only actual budget failures', () => {
    expect(formatNudge({ failures: [] })).toBe('');
    expect(formatNudge({ failures: [{ surface: 'su-base:power', message: 'over by 4 B' }] })).toContain('over by 4 B');
  });

  it('fails open when the checker cannot run', () => {
    expect(nudgeFor('Edit', { file_path: '/repo/apps/operator/prompts/foo.md' }, {
      root: '/repo',
      run: () => null,
    })).toContain('NOT checked');
  });

  it('retains a failing checker report from exit-1 stdout', () => {
    const report = { ok: false, failures: [{ message: 'power over by 4 B' }] };
    const result = runBudget('/repo', () => { throw Object.assign(new Error('exit 1'), { status: 1, stdout: JSON.stringify(report) }); });
    expect(result).toEqual(report);
    expect(formatNudge(result)).toContain('power over by 4 B');
    expect(runBudget('/repo', () => { throw Object.assign(new Error('timeout'), { status: null }); })).toBeNull();
  });

  it('finds the repository from a nested hook path', () => {
    expect(findRepoRoot('/repo/apps/operator/prompts/foo.md', (path) => path === '/repo/scripts/check-launch-prose-budget.ts')).toBe('/repo');
  });
});
