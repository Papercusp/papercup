/**
 * capability-category-map.test.ts — pins the tool/verb → category map (B-04 /
 * P-020). The load-bearing assertions: (1) the SIX governance actions that share
 * the single `harness:write` capability resolve to SIX DISTINCT correct
 * categories — the proof that keying on the tool name, not the capability bucket,
 * is necessary (D-002 anti-collapse); (2) the fail-safe — an unmapped action is
 * `null` (the gate treats it as never-auto, D-009); (3) every PROTECTED action
 * resolves to a PROTECTED category.
 */
import { describe, it, expect } from 'vitest';
import { categoryForAction, classifyActionCategory } from './capability-category-map';
import { isProtectedCategory, isAutonomyCategory } from './categories';

describe('capability→category map: the anti-collapse proof (D-002)', () => {
  // All six share capability `harness:write`. If the map keyed on the capability
  // string they would collapse to one category; keyed on the tool name they must
  // split into the six distinct categories across four posture levels.
  const SHARED_CAPABILITY = 'harness:write';
  const cases: Array<[string, string]> = [
    ['deploy:harness', 'release-deploy'],
    ['accounts:scale_out', 'spend-budget'],
    ['accounts:register', 'credentials-auth'],
    ['hive:create', 'agent-lifecycle'],
    ['scout:grade-idea', 'ideation-intake'],
    ['learning_packs:publish', 'knowledge-curation'],
  ];

  it.each(cases)('%s → %s (despite all sharing harness:write)', (action, expected) => {
    expect(categoryForAction(action, SHARED_CAPABILITY)).toBe(expected);
  });

  it('the six resolve to six DISTINCT categories', () => {
    const cats = cases.map(([a]) => categoryForAction(a, SHARED_CAPABILITY));
    expect(new Set(cats).size).toBe(6);
  });
});

describe('capability→category map: specific-over-group overrides', () => {
  it.each([
    // hive: group default is agent-lifecycle, but these verbs override
    ['hive:cross_grant', 'credentials-auth'],
    ['hive:declare-wake', 'system-control'],
    ['hive:ask', 'escalations'],
    ['hive:request_work', 'escalations'],
    ['hive:start', 'agent-lifecycle'],
    // accounts: splits credentials vs spend
    ['accounts:remove', 'credentials-auth'],
    // conversations: group default is escalations, promote overrides
    ['conversations:promote', 'ideation-intake'],
    ['conversations:answer', 'escalations'],
    // plans: group default plan-governance, attention overrides to inbox
    ['plans:attention', 'inbox-triage'],
    ['plans:set-status', 'plan-governance'],
    // new_subagent: request (ask) vs approve (lifecycle)
    ['new_subagent:request', 'escalations'],
    ['new_subagent:approve', 'agent-lifecycle'],
  ])('%s → %s', (action, expected) => {
    expect(categoryForAction(action)).toBe(expected);
  });
});

describe('capability→category map: fail-safe (D-009)', () => {
  it('returns null for an unmapped / non-governance tool (gate → never-auto)', () => {
    expect(categoryForAction('search:fulltext', 'search:read')).toBeNull();
    expect(categoryForAction('locks:acquire', 'locks:write')).toBeNull();
    expect(categoryForAction('coord:send', 'coord:write')).toBeNull();
    expect(categoryForAction('totally:unknown')).toBeNull();
  });

  it('the coarse capability fallback only routes toward a PROTECTED category', () => {
    // an unmapped tool name, but a sensitive capability prefix → protected
    expect(categoryForAction('mystery:verb', 'secrets:some-key')).toBe('credentials-auth');
    expect(categoryForAction('mystery:verb', 'compute:exec:python')).toBe('system-control');
    // a non-sensitive capability never rescues an unmapped tool
    expect(categoryForAction('mystery:verb', 'work_items:read')).toBeNull();
  });
});

describe('capability→category map: protected actions land in protected categories', () => {
  it.each([
    'deploy:harness',
    'deploy:teardown',
    'operator:budget',
    'accounts:scale_out',
    'accounts:register',
    'flags:set',
    'autoloop:control',
    'routines:write',
    'backup:restore',
    'processes:kill',
    'hive:cross_grant',
  ])('%s resolves to a protected category', (action) => {
    const cat = categoryForAction(action);
    expect(cat).not.toBeNull();
    expect(isProtectedCategory(cat!)).toBe(true);
  });
});

describe('capability→category map: shape', () => {
  it('classifyActionCategory carries a non-empty reason and a valid category', () => {
    const r = classifyActionCategory('deploy:harness');
    expect(r).not.toBeNull();
    expect(r!.reason.length).toBeGreaterThan(0);
    expect(isAutonomyCategory(r!.category)).toBe(true);
  });
  it('every resolved category is one of the 13 canonical ids', () => {
    for (const a of ['fleet:spawn', 'plans:promote', 'memory:forget', 'gym:judge', 'issues:promote']) {
      const cat = categoryForAction(a);
      expect(cat).not.toBeNull();
      expect(isAutonomyCategory(cat!)).toBe(true);
    }
  });
});
