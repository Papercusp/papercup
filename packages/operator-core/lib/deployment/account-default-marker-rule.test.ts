/**
 * account-default-marker-rule.test.ts — EI-19944784972017743.
 *
 * The rule keeps a SIBLING long-lived host's per-process
 * `PAPERCUSP_DEFAULT_ACCOUNT_ACTIVE` marker in step with the owner's account
 * override, by reacting to the change stream that override table already emits.
 *
 * WHAT THESE TESTS ARE REALLY GUARDING. The failure mode here is a rule that
 * matches NOTHING and is indistinguishable from a healthy one in production: if
 * the rule's table name drifts from the real `OVERRIDE_STATE_TABLE`, `when` is
 * simply always false, no resync ever fires, and the symptom — a marker that
 * stays stale — looks exactly like "the owner never changed the default". So the
 * positive case below builds its event from the REAL exported constant rather
 * than a literal: renaming the table fails this test instead of silently killing
 * the rule (the derived-truth PIN the rule module's comment points at).
 *
 * FALSIFIABILITY. Every "fires" assertion is paired with a control that differs
 * in one field and must NOT fire, so a predicate stuck at `true` fails a control
 * and one stuck at `false` fails a positive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import {
  registerAccountDefaultMarkerRule,
  ACCOUNT_DEFAULT_MARKER_RULE_ID,
} from './account-default-marker-rule';
import { OVERRIDE_STATE_TABLE } from './account-session-override';
import { matchReactions } from '../events/registry';
import {
  ACCOUNT_DEFAULT_MARKER_SYNC_ACTION,
  BUILTIN_ACTIONS,
  fireBuiltinReactionAction,
} from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';

const syncDefaultAccountEnv = vi.fn();
vi.mock('./account-pool-store', () => ({
  syncDefaultAccountEnv: (...args: unknown[]) => syncDefaultAccountEnv(...args),
}));

const ctx = { harnessSlug: 'papercusp', runId: 'run-1' } as unknown as UnifiedToolContext;

/** A `<schema>.<table>.changed` event as the sync change stream emits it. */
function changedEvent(table: string, schema = 'harness_shared'): ToolInvocationEvent {
  return {
    tool: `${schema}.${table}.changed`,
    args: { workspace_id: 'papercusp-workspace', op: 'UPDATE' },
    result: { ok: true },
    ctx,
  };
}

const matched = (e: ToolInvocationEvent) =>
  matchReactions(e).find((a) => a.ruleId === ACCOUNT_DEFAULT_MARKER_RULE_ID);

beforeEach(() => {
  syncDefaultAccountEnv.mockReset();
  syncDefaultAccountEnv.mockResolvedValue(true);
  registerAccountDefaultMarkerRule(); // idempotent by stable id
});

describe('the rule matches the override table, and only it', () => {
  it('FIRES on a change to the real override table, dispatching the marker-sync action', () => {
    // Built from the exported constant on purpose — see the header note.
    const action = matched(changedEvent(OVERRIDE_STATE_TABLE));
    expect(action).toBeDefined();
    expect(action!.fire).toBe(ACCOUNT_DEFAULT_MARKER_SYNC_ACTION);
  });

  it('does NOT fire for a different table (control)', () => {
    expect(matched(changedEvent('coord_links'))).toBeUndefined();
    // The sibling account table is the most plausible near-miss: the POOL moves
    // constantly (the gateway rewrites it on every response's rate headers), so
    // matching it would turn a routing-preference resync into a hot-path resync.
    expect(matched(changedEvent('operator_account_pool'))).toBeUndefined();
  });

  it('does NOT fire for a non-change event (control)', () => {
    const notAChange: ToolInvocationEvent = {
      tool: 'accounts:set-default',
      args: {},
      result: { ok: true },
      ctx,
    };
    expect(matched(notAChange)).toBeUndefined();
  });

  it('matches regardless of the schema prefix the stream emits', () => {
    // tableNameFromChangedEvent strips `<schema>.`, so the rule must not be
    // pinned to one schema spelling.
    expect(matched(changedEvent(OVERRIDE_STATE_TABLE, 'public'))).toBeDefined();
  });
});

describe('the built-in action', () => {
  it('is registered as a built-in, so dispatch runs it in-process and never looks for a tool', () => {
    expect(BUILTIN_ACTIONS.has(ACCOUNT_DEFAULT_MARKER_SYNC_ACTION)).toBe(true);
  });

  it('re-publishes the marker for the TRIGGER’s workspace', async () => {
    const res = await fireBuiltinReactionAction(
      ACCOUNT_DEFAULT_MARKER_SYNC_ACTION,
      {},
      'papercusp-workspace',
    );
    expect(res.ok).toBe(true);
    // The workspace must be threaded through: a resync against the WRONG
    // workspace would publish another tenant's default onto this process.
    expect(syncDefaultAccountEnv).toHaveBeenCalledWith('papercusp-workspace');
  });

  it('is fail-soft — a resync failure is not reported as a failure of the write that triggered it', async () => {
    syncDefaultAccountEnv.mockRejectedValue(new Error('pg down'));
    const res = await fireBuiltinReactionAction(
      ACCOUNT_DEFAULT_MARKER_SYNC_ACTION,
      {},
      'papercusp-workspace',
    );
    expect(res.ok).toBe(true);
    expect(syncDefaultAccountEnv).toHaveBeenCalledTimes(1);
  });

  it('still rejects an unknown action (the switch has not been made permissive)', async () => {
    const res = await fireBuiltinReactionAction('accounts.nopeNotReal', {}, 'papercusp-workspace');
    expect(res.ok).toBe(false);
  });
});
