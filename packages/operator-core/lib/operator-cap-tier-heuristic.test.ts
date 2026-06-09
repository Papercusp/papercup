import { describe, expect, it } from 'vitest';
import { heuristicTier } from './operator-cap-tier-heuristic';

describe('heuristicTier — high-risk patterns', () => {
  it.each([
    'secrets:read:OPENAI_API_KEY',
    'secrets:write:foo',
    'secrets:operator-credentials:read', // : read suffix shouldn't downgrade
  ])('%s → high', (cap) => expect(heuristicTier(cap)?.tier).toBe('high'));

  it.each([
    'compute:exec:repomix',
    'compute:exec:gitnexus',
    'compute:exec:npx',
  ])('%s → high', (cap) => expect(heuristicTier(cap)?.tier).toBe('high'));

  it('processes:kill → high', () => {
    expect(heuristicTier('processes:kill')?.tier).toBe('high');
  });

  it('harness:dispatch:<slug> → high', () => {
    expect(heuristicTier('harness:dispatch:foo')?.tier).toBe('high');
  });

  it('pending_events:write → high', () => {
    expect(heuristicTier('pending_events:write')?.tier).toBe('high');
  });

  it('tools:orchestrator:spawn:worker → high', () => {
    expect(heuristicTier('tools:orchestrator:spawn:worker')?.tier).toBe('high');
  });
});

describe('heuristicTier — medium patterns', () => {
  it.each([
    'http:fetch:api.firecrawl.dev',
    'http:fetch:r.jina.ai',
  ])('%s → medium', (cap) => expect(heuristicTier(cap)?.tier).toBe('medium'));

  it.each([
    'db:write:harness_design_artifacts',
    'db:write:harness_features_consolidated',
  ])('%s → medium', (cap) => expect(heuristicTier(cap)?.tier).toBe('medium'));

  it.each([
    'plugins:write',
    'autoloop:write',
    'omp:write',
  ])('%s → medium', (cap) => expect(heuristicTier(cap)?.tier).toBe('medium'));

  it.each([
    'tasks:write',
    'features:write',
    'messages:write',
    'artifacts:write',
  ])('%s → medium', (cap) => expect(heuristicTier(cap)?.tier).toBe('medium'));

  it.each([
    'tools:firecrawl:scrape',
    'tools:firecrawl:extract',
    'tools:web:fetch_clean',
  ])('%s → medium', (cap) => expect(heuristicTier(cap)?.tier).toBe('medium'));

  it.each([
    'tools:design:submit_spec',
    'tools:design:record_review',
    'tools:design:lint_spec',
    'tools:design:validate_spec',
  ])('%s → medium', (cap) => expect(heuristicTier(cap)?.tier).toBe('medium'));

  it.each([
    'tools:gitnexus:rename',
    'tools:gitnexus:group_sync',
    'tools:gitnexus:detect_changes',
  ])('%s → medium', (cap) => expect(heuristicTier(cap)?.tier).toBe('medium'));
});

describe('heuristicTier — low patterns', () => {
  it.each([
    'tasks:read',
    'features:read',
    'audit:read',
    'agents:read',
    'projects:read',
    'goals:read',
  ])('%s → low', (cap) => expect(heuristicTier(cap)?.tier).toBe('low'));

  it.each([
    'tools:design:get_accepted_spec',
    'tools:design:list_memos',
    'tools:gitnexus:context',
    'tools:gitnexus:cypher',
    'tools:gitnexus:list_repos',
    'tools:repomix:pack',
    'tools:code2prompt:diff',
  ])('%s → low', (cap) => expect(heuristicTier(cap)?.tier).toBe('low'));

  it.each([
    'hindsight:recall',
    'search:query',
  ])('%s → low', (cap) => expect(heuristicTier(cap)?.tier).toBe('low'));
});

describe('heuristicTier — unrecognized', () => {
  it('returns null for caps that match no pattern', () => {
    expect(heuristicTier('foo:bar:baz')).toBeNull();
    expect(heuristicTier('completely-unknown')).toBeNull();
  });
});

describe('heuristicTier — coverage of the live catalog', () => {
  // Sampled from `curl /api/plugins/tools | jq '[.[] | .capabilities[]] | unique'`
  // at 2026-05-11. Pinned so a heuristic regression that drops a real
  // production capability surfaces as a test failure.
  const SAMPLES: { cap: string; expected: 'low' | 'medium' | 'high' }[] = [
    { cap: 'actions:read', expected: 'low' },
    { cap: 'agent_chats:read', expected: 'low' },
    { cap: 'agent_chats:write', expected: 'medium' },
    { cap: 'compute:exec:code2prompt', expected: 'high' },
    { cap: 'compute:exec:gitnexus', expected: 'high' },
    { cap: 'cross_harness:read', expected: 'low' },
    { cap: 'fs:read:design_memos', expected: 'low' },
    { cap: 'http:fetch:r.jina.ai', expected: 'medium' },
    { cap: 'intel:read', expected: 'low' },
    { cap: 'plugins:read', expected: 'low' },
    { cap: 'plugins:write', expected: 'medium' },
    { cap: 'processes:kill', expected: 'high' },
    { cap: 'secrets:read:FIRECRAWL_API_KEY', expected: 'high' },
    { cap: 'workspaces:read', expected: 'low' },
  ];
  it.each(SAMPLES)('$cap → $expected', ({ cap, expected }) => {
    expect(heuristicTier(cap)?.tier).toBe(expected);
  });
});
