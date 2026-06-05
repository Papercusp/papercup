/**
 * Shared "is this the operator's own API?" + ?ws= stamping used by both the
 * fetch and EventSource workspace wrappers (per-window-workspace-context P-013/
 * P-015). window is stubbed (bare node env), mirroring browser-workspace.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOperatorApiUrl, withWorkspaceParam } from './workspace-api-target';

afterEach(() => vi.unstubAllGlobals());

function stubLoc() {
  vi.stubGlobal('window', {
    location: { href: 'http://127.0.0.1:3070/adv', origin: 'http://127.0.0.1:3070' },
  });
}

describe('isOperatorApiUrl', () => {
  it('true for same-origin /api/* (relative + absolute)', () => {
    stubLoc();
    expect(isOperatorApiUrl('/api/zero-harness/sse')).toBe(true);
    expect(isOperatorApiUrl('http://127.0.0.1:3070/api/x')).toBe(true);
  });
  it('false for non-/api paths', () => {
    stubLoc();
    expect(isOperatorApiUrl('/assets/app.js')).toBe(false);
  });
  it('true for loopback cross-origin /api (dev :3055 → :3070)', () => {
    stubLoc();
    expect(isOperatorApiUrl('http://localhost:3055/api/x')).toBe(true);
  });
  it('false for a genuinely external /api host', () => {
    stubLoc();
    expect(isOperatorApiUrl('https://example.com/api/x')).toBe(false);
  });
});

describe('withWorkspaceParam', () => {
  it('appends ?ws= to a relative URL, preserving its relative form', () => {
    stubLoc();
    expect(withWorkspaceParam('/api/zero-harness/sse', 'ws-7')).toBe('/api/zero-harness/sse?ws=ws-7');
  });
  it('merges ?ws= alongside an existing query', () => {
    stubLoc();
    expect(withWorkspaceParam('/api/x?since=5', 'ws-7')).toBe('/api/x?since=5&ws=ws-7');
  });
  it('does not override an explicit ?ws=', () => {
    stubLoc();
    expect(withWorkspaceParam('/api/x?ws=ws-explicit', 'ws-7')).toBe('/api/x?ws=ws-explicit');
  });
  it('keeps an absolute URL absolute', () => {
    stubLoc();
    expect(withWorkspaceParam('http://localhost:3055/api/x', 'ws-7')).toBe(
      'http://localhost:3055/api/x?ws=ws-7',
    );
  });
});
