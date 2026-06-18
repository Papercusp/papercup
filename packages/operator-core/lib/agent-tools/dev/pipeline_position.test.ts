import { describe, it, expect } from 'vitest';
import tool from './pipeline_position';

/**
 * deploy-pipeline-legibility-2026-06-18 P-005: the shared DEPLOY_PIPELINE_NOTE (in every spawned
 * role's prompt) tells EVERY execution/judgment role to reach for `dev:pipeline_position` instead
 * of polling :3070. So the tool's allowlist MUST cover them all — this guards against a silent
 * re-narrowing that would re-break the note's promise. The tool is read-only (intel:read), so a
 * wide allowlist is safe.
 */
describe('dev:pipeline_position role allowlist', () => {
  it('is available to every execution/judgment role the cross-role note points at', () => {
    const roles = new Set(tool.agentRoles ?? []);
    const expected = [
      'operator', 'queen', 'architect', 'worker', 'scoper', 'validator', 'reviewer',
      'debugger', 'documenter', 'curator', 'bee', 'sentinel', 'overwatch',
      'release-fixer', 'merge-resolver', 'content-fixer', 'release-manager',
    ];
    for (const r of expected) {
      expect(roles.has(r), `pipeline_position must be allowed for role '${r}'`).toBe(true);
    }
  });
});
