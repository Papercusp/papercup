/**
 * capability-explain renders the consent-prompt labels users see when
 * a plugin asks for a permission. Wrong/missing labels = users can't
 * make an informed grant decision; pinning the matrix here so a refactor
 * doesn't silently regress what the prompt says.
 */
import { describe, it, expect } from 'vitest';
import { explainCapability, tierBadgeColor } from './capability-explain';

describe('explainCapability — exact-match rules', () => {
  it.each([
    ['tasks:read', 'Read your tasks'],
    ['tasks:write', 'Create, edit, or delete tasks'],
    ['features:read', 'Read your features'],
    ['features:write', 'Create, edit, or delete features'],
    ['messages:read', 'Read messages between harnesses'],
    ['messages:write', 'Send messages to other harnesses'],
    ['projects:read', 'List your harnesses / projects'],
    ['audit:list', 'Read the plugin audit log'],
    ['search:query', 'Run searches across harness content'],
    ['hindsight:recall', 'Recall from your hindsight memory'],
  ])('%s → "%s"', (cap, label) => {
    expect(explainCapability(cap).label).toBe(label);
  });
});

describe('explainCapability — wildcard / resource rules', () => {
  it('secrets:read:<NAME> shows the secret name', () => {
    expect(explainCapability('secrets:read:OPENAI_API_KEY').label).toBe('Read secret "OPENAI_API_KEY"');
  });

  it('http:fetch:<host> shows the host', () => {
    expect(explainCapability('http:fetch:api.foo.com').label).toBe('Make HTTP requests to api.foo.com');
  });

  it('http:fetch:* renders as "any host"', () => {
    expect(explainCapability('http:fetch:*').label).toBe('Make HTTP requests to any host');
  });

  it('compute:exec:<bin> shows the binary', () => {
    expect(explainCapability('compute:exec:ffmpeg').label).toBe('Execute the binary "ffmpeg"');
  });

  it('events:emit/on quote the event name', () => {
    expect(explainCapability('events:emit:briefing-ready').label).toBe('Emit "briefing-ready" events');
    expect(explainCapability('events:on:mission-done').label).toBe('Listen for "mission-done" events');
  });

  it('kv:read/write expose the namespace', () => {
    expect(explainCapability('kv:read:userprefs').label).toBe('Read its own key-value store (namespace userprefs)');
  });

  it('data:read/write expose kind + scope', () => {
    expect(explainCapability('data:read:harness:active').label).toBe('Read harness data (active)');
  });
});

describe('explainCapability — return shape', () => {
  it('always includes cap + tier alongside label', () => {
    const r = explainCapability('tasks:read');
    expect(r.cap).toBe('tasks:read');
    expect(typeof r.label).toBe('string');
    expect(['low', 'medium', 'high']).toContain(r.tier);
  });

  it('unknown caps fall back to a humanised label', () => {
    const r = explainCapability('something:weird:foo');
    expect(r.label.length).toBeGreaterThan(0);
    expect(r.cap).toBe('something:weird:foo');
  });
});

describe('tierBadgeColor', () => {
  it('returns a non-empty color for each tier', () => {
    expect(tierBadgeColor('low').length).toBeGreaterThan(0);
    expect(tierBadgeColor('medium').length).toBeGreaterThan(0);
    expect(tierBadgeColor('high').length).toBeGreaterThan(0);
  });

  it('high differs from low', () => {
    expect(tierBadgeColor('high')).not.toBe(tierBadgeColor('low'));
  });
});
