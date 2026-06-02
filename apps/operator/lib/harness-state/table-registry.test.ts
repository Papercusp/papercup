import { describe, it, expect } from 'vitest';
import {
  resolveTableSpec,
  needsReview,
  NEEDS_REVIEW,
  DEFAULT_SPEC,
} from './table-registry';

describe('harness-state table-registry (P-002 two-axis model)', () => {
  it('classifies the GIT-document tables: slug-shared + git', () => {
    for (const t of ['harness_decisions', 'harness_text_artifacts', 'feature_audit_consolidated']) {
      const s = resolveTableSpec(t);
      expect(s).toMatchObject({ key: 'slug-shared', sync: 'git' });
    }
  });

  it('classifies the live shared tables: slug-shared + peer-log', () => {
    for (const t of ['harness_features_consolidated', 'feature_queue', 'contributors']) {
      const s = resolveTableSpec(t);
      expect(s).toMatchObject({ key: 'slug-shared', sync: 'peer-log' });
    }
  });

  it('classifies operator/user/session tables as workspace-owned (prefix rule)', () => {
    for (const t of ['operator_preferences', 'user_sessions', 'voice_lease', 'adv_sessions']) {
      expect(resolveTableSpec(t).key).toBe('workspace-owned');
      expect(resolveTableSpec(t).sync).toBe('none');
    }
  });

  it('SECURITY tables never sync and win over the operator_ prefix', () => {
    for (const t of ['operator_credentials', 'oauth_nonces', 'system_principals', 'mobile_pair_tokens']) {
      const s = resolveTableSpec(t);
      expect(s.security).toBe(true);
      expect(s.sync).toBe('none'); // invariant: security ⇒ never cross machines
      expect(s.key).toBe('workspace-owned');
    }
  });

  it('the across-workspaces config override is workspace-owned', () => {
    expect(resolveTableSpec('harness_prompt_overrides').key).toBe('workspace-owned');
  });

  it('falls through to DEFAULT (slug-shared / none) for plain result tables', () => {
    // agent_runs_consolidated / agent_chats_consolidated are §7.4 LOCAL runtime: slug-keyed, not synced.
    expect(resolveTableSpec('agent_runs_consolidated')).toEqual(DEFAULT_SPEC);
    expect(resolveTableSpec('agent_chats_consolidated')).toEqual(DEFAULT_SPEC);
  });

  it('strips a schema qualifier before resolving', () => {
    expect(resolveTableSpec('harness_shared.harness_decisions')).toMatchObject({ sync: 'git' });
    expect(resolveTableSpec('papercup_shared.messages')).toMatchObject({ sync: 'git' });
  });

  it('every NEEDS_REVIEW table still resolves (no throw) and is flagged', () => {
    for (const t of Object.keys(NEEDS_REVIEW)) {
      expect(() => resolveTableSpec(t)).not.toThrow();
      expect(needsReview(t)).toBe(true);
    }
  });

  it('invariant: security always implies sync none', () => {
    for (const t of ['operator_secrets', 'token_index', 'provision_state']) {
      const s = resolveTableSpec(t);
      if (s.security) expect(s.sync).toBe('none');
    }
  });
});
