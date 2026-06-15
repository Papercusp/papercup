// @vitest-environment jsdom
//
// PiPanel — embedded omp terminal pane. The component body is an effect-only
// xterm/SSE/WS shell (e2e territory), but two pure URL/key helpers carry real
// branching: `ptyWsUrlForId` (the WS-vs-SSE data-path decision) and
// `ptyResumeKey` (the sessionStorage resume key). Those are exported + tested
// here. The transport deps (@papercusp/sse, pty-tauri) and nuqs are mocked so
// importing the module doesn't pull a live transport.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/sse', () => ({ createResilientEventSource: () => ({ close: () => {} }) }));
vi.mock('@papercusp/operator-core/lib/pty-tauri', () => ({
  isTauriNative: () => false,
  openNativeSession: async () => ({}),
}));
vi.mock('nuqs', () => ({
  useQueryState: () => [false, () => {}],
  parseAsBoolean: { withDefault: () => ({}) },
}));
vi.mock('./Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import { ptyWsUrlForId, ptyResumeKey } from './PiPanel';

// Typed view of the runtime-injected window overrides the helper reads.
const w = window as unknown as { __PAPERCUSP_PTY_WS__?: string | null; __PAPERCUSP_TAURI__?: unknown };

afterEach(() => {
  // Reset any window override the tests set.
  delete w.__PAPERCUSP_PTY_WS__;
  delete w.__PAPERCUSP_TAURI__;
});

describe('ptyResumeKey', () => {
  it('namespaces by slug, panel, and lane', () => {
    expect(ptyResumeKey('myslug', 'panel-1', 'lane-3')).toBe('papercusp:pi-pty:myslug:panel-1:lane-3');
  });
  it('defaults the panel segment and blanks a missing lane', () => {
    expect(ptyResumeKey('myslug', undefined, undefined)).toBe('papercusp:pi-pty:myslug:default:');
  });
  it('distinguishes two panels of the same slug', () => {
    expect(ptyResumeKey('s', 'a', undefined)).not.toBe(ptyResumeKey('s', 'b', undefined));
  });
});

describe('ptyWsUrlForId', () => {
  it('returns null (SSE only) when a Tauri native pty is present', () => {
    w.__PAPERCUSP_TAURI__ = { kind: 'native', spawn: () => {} };
    expect(ptyWsUrlForId('pty1')).toBeNull();
  });

  it('returns null when WS is explicitly opted out (override === null)', () => {
    w.__PAPERCUSP_PTY_WS__ = null;
    expect(ptyWsUrlForId('pty1')).toBeNull();
  });

  it('builds the WS url from a runtime override, appending the encoded pty id', () => {
    w.__PAPERCUSP_PTY_WS__ = 'ws://host:9999';
    expect(ptyWsUrlForId('pty/with slash')).toBe('ws://host:9999/pty/pty%2Fwith%20slash');
  });

  it('strips a trailing slash from the override base before appending', () => {
    w.__PAPERCUSP_PTY_WS__ = 'ws://host:9999/';
    expect(ptyWsUrlForId('abc')).toBe('ws://host:9999/pty/abc');
  });

  it('skips WS (returns null) when unconfigured and not on the :3055 dev port', () => {
    // jsdom default location is http://localhost/ (no :3055), and no override
    // or build-env endpoint is set in the test env → skip WS, let SSE handle it.
    expect(ptyWsUrlForId('abc')).toBeNull();
  });
});
