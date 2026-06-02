import { describe, it, expect } from 'vitest';
import {
  resolveTableSpec,
  needsReview,
  classifyInventory,
  NEEDS_REVIEW,
  DEFAULT_SPEC,
  GIT_TABLES,
} from './table-registry';

describe('harness-state table-registry (P-002 two-axis model)', () => {
  it('classifies the GIT-document tables: slug-shared + git', () => {
    for (const t of ['harness_decisions', 'harness_text_artifacts', 'feature_audit_consolidated', 'harness_feature_debug_notes']) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'slug-shared', sync: 'git' });
    }
  });

  it('classifies the live shared tables: slug-shared + peer-log', () => {
    for (const t of ['harness_features_consolidated', 'feature_queue', 'contributors']) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'slug-shared', sync: 'peer-log' });
    }
  });

  it('classifies operator/user/session tables as workspace-owned (prefix rule)', () => {
    for (const t of ['operator_preferences', 'user_sessions', 'voice_lease', 'adv_sessions']) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'workspace-owned', sync: 'none' });
    }
  });

  it('P-002 review: telemetry / mem0 / coord / plugin / backup → workspace-owned', () => {
    for (const t of [
      'tool_invocations', 'tool_invocations_spawn_tree', 'route_invocations', 'adaptive_telemetry',
      'memory_anchors', 'memory_vec_local',
      'coord_presence', 'coord_event_log',
      'plugin_configs', 'hidden_plugins',
      'backup_events', 'spawned_agents',
    ]) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'workspace-owned', sync: 'none' });
    }
  });

  it('SECURITY tables never sync and win over the operator_ prefix', () => {
    for (const t of ['operator_credentials', 'oauth_nonces', 'system_principals', 'mobile_pair_tokens']) {
      const s = resolveTableSpec(t);
      expect(s.security).toBe(true);
      expect(s.sync).toBe('none');
      expect(s.key).toBe('workspace-owned');
    }
  });

  it('legacy papercup-org tables are tagged legacy (D-008), DEFAULT otherwise', () => {
    const s = resolveTableSpec('org_charter');
    expect(s.legacy).toBe(true);
    expect(s).toMatchObject({ key: 'slug-shared', sync: 'none' });
  });

  it('the across-workspaces config override is workspace-owned', () => {
    expect(resolveTableSpec('harness_prompt_overrides').key).toBe('workspace-owned');
  });

  it('P-002 completeness review: per-workspace tables are workspace-owned (not slug-shared)', () => {
    // harness_registry is the membership list — one row per workspace; must NOT be slug-shared.
    for (const t of ['harness_registry', 'plan_revisions', 'plan_runs', 'harness_brainstorm', 'harness_dock_layouts', 'autoloop_state']) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'workspace-owned', sync: 'none' });
    }
  });

  it('falls through to DEFAULT (slug-shared / none) for plain result tables', () => {
    // §7.4 LOCAL runtime, slug-keyed, not synced; substrate plumbing is local.
    expect(resolveTableSpec('agent_runs_consolidated')).toEqual(DEFAULT_SPEC);
    expect(resolveTableSpec('agent_chats_consolidated')).toEqual(DEFAULT_SPEC);
    expect(resolveTableSpec('substrate_outbox')).toEqual(DEFAULT_SPEC);
    expect(resolveTableSpec('pr_check_status_cache')).toEqual(DEFAULT_SPEC);
  });

  it('strips a schema qualifier before resolving', () => {
    expect(resolveTableSpec('harness_shared.harness_decisions')).toMatchObject({ sync: 'git' });
    expect(resolveTableSpec('papercup_shared.messages')).toMatchObject({ sync: 'git' });
  });

  it('excludes fs-watcher-derived mirrors from git-export: harness_branch_actions (volatile last_check_ms → churn)', () => {
    // harness_branch_actions is a local fs-watcher projection (Mirror 7k:
    // `git log` enrichment) whose `last_check_ms` heartbeat is re-upserted on
    // every poll regardless of content. Classifying it sync:'git' produced a
    // perpetual export loop (P-003b live-boot). It must NOT be git-synced — the
    // source is already in git and PG is a local recompute; it falls to DEFAULT.
    const s = resolveTableSpec('harness_branch_actions');
    expect(s.sync).not.toBe('git');
    expect(s).toEqual(DEFAULT_SPEC);
    expect(GIT_TABLES).not.toContain('harness_branch_actions');
  });

  it('NEEDS_REVIEW is empty at P-002 close', () => {
    expect(Object.keys(NEEDS_REVIEW)).toHaveLength(0);
    expect(needsReview('anything')).toBe(false);
  });

  it('invariant: security always implies sync none', () => {
    for (const t of ['operator_secrets', 'token_index', 'provision_state']) {
      const s = resolveTableSpec(t);
      if (s.security) expect(s.sync).toBe('none');
    }
  });

  it('classifyInventory groups a live list + surfaces defaulted / unreviewed', () => {
    const sample = [
      'harness_features_consolidated', // peer-log
      'harness_decisions',             // git
      'operator_preferences',          // workspace-owned (prefix)
      'operator_credentials',          // security
      'org_charter',                   // legacy
      'agent_runs_consolidated',       // DEFAULT
      'some_brand_new_table',          // DEFAULT (would be flagged as defaulted → review)
    ];
    const c = classifyInventory(sample);
    expect(c.total).toBe(7);
    expect(c.unreviewed).toHaveLength(0); // NEEDS_REVIEW empty
    // a NEW unclassified table surfaces in `defaulted` so it can't hide:
    expect(c.defaulted).toContain('some_brand_new_table');
    expect(c.defaulted).toContain('agent_runs_consolidated');
    expect(c.defaulted).not.toContain('harness_features_consolidated');
    expect(c.byBucket['slug-shared/peer-log']).toBe(1);
    expect(c.byBucket['workspace-owned/none/sec']).toBe(1);
  });
});
