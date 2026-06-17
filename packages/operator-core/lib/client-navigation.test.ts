/**
 * Coverage for client-navigation: the pure soft/hard/none decision
 * (shouldSoftNavigate + resolveClientNavigation) and navigateClient's dispatch
 * (history pushState/replaceState + popstate vs location.assign/replace).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldSoftNavigate, resolveClientNavigation, navigateClient } from './client-navigation';

const CUR = 'http://localhost:3070/harness/p';

describe('shouldSoftNavigate', () => {
  it('true for a same-origin target', () => {
    expect(shouldSoftNavigate('/other', CUR)).toBe(true);
    expect(shouldSoftNavigate('http://localhost:3070/x', CUR)).toBe(true);
  });
  it('false for a cross-origin target', () => {
    expect(shouldSoftNavigate('http://evil.com/x', CUR)).toBe(false);
    expect(shouldSoftNavigate('http://localhost:9999/x', CUR)).toBe(false); // different port = different origin
  });
  it('false for a non-http(s) scheme', () => {
    expect(shouldSoftNavigate('mailto:a@b.c', CUR)).toBe(false);
    expect(shouldSoftNavigate('javascript:alert(1)', CUR)).toBe(false);
  });
});

describe('resolveClientNavigation', () => {
  it('soft-navigates same-origin to a path+search+hash href', () => {
    expect(resolveClientNavigation('http://localhost:3070/a?b=1#c', CUR)).toEqual({
      mode: 'soft',
      href: '/a?b=1#c',
      replace: false,
    });
  });
  it('hard-navigates cross-origin to the full href', () => {
    expect(resolveClientNavigation('http://evil.com/x', CUR)).toEqual({
      mode: 'hard',
      href: 'http://evil.com/x',
      replace: false,
    });
  });
  it('returns none for a non-http(s) target', () => {
    expect(resolveClientNavigation('mailto:a@b.c', CUR)).toEqual({
      mode: 'none',
      href: null,
      replace: false,
    });
  });
  it('threads the replace flag', () => {
    expect(resolveClientNavigation('/a', CUR, { replace: true }).replace).toBe(true);
  });
  it('forces hard navigation when opts.hard is set, even for a same-origin target', () => {
    expect(resolveClientNavigation('http://localhost:3070/harness?ws=beta', CUR, { hard: true })).toEqual({
      mode: 'hard',
      href: 'http://localhost:3070/harness?ws=beta',
      replace: false,
    });
  });
  it('forces hard navigation when the target switches to a different workspace', () => {
    expect(resolveClientNavigation('/harness?ws=beta', CUR, { currentWorkspaceId: 'alpha' })).toEqual({
      mode: 'hard',
      href: 'http://localhost:3070/harness?ws=beta',
      replace: false,
    });
  });
  it('stays soft when the target keeps the same workspace', () => {
    expect(resolveClientNavigation('/harness?ws=alpha', CUR, { currentWorkspaceId: 'alpha' })).toEqual({
      mode: 'soft',
      href: '/harness?ws=alpha',
      replace: false,
    });
  });
  it('stays soft when the target carries no workspace param', () => {
    expect(resolveClientNavigation('/other', CUR, { currentWorkspaceId: 'alpha' })).toEqual({
      mode: 'soft',
      href: '/other',
      replace: false,
    });
  });
});

describe('navigateClient', () => {
  function stubWindow() {
    const win = {
      location: { href: CUR, assign: vi.fn(), replace: vi.fn() },
      history: { pushState: vi.fn(), replaceState: vi.fn() },
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal('window', win);
    vi.stubGlobal('PopStateEvent', class { constructor(public type: string) {} });
    return win;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('soft nav pushes state + dispatches popstate', () => {
    const w = stubWindow();
    navigateClient('/dest?q=1');
    expect(w.history.pushState).toHaveBeenCalledWith({}, '', '/dest?q=1');
    expect(w.dispatchEvent).toHaveBeenCalledOnce();
    expect(w.location.assign).not.toHaveBeenCalled();
  });

  it('soft nav with replace uses replaceState', () => {
    const w = stubWindow();
    navigateClient('/dest', { replace: true });
    expect(w.history.replaceState).toHaveBeenCalledWith({}, '', '/dest');
  });

  it('hard nav uses location.assign (or replace)', () => {
    const w = stubWindow();
    navigateClient('http://evil.com/x');
    expect(w.location.assign).toHaveBeenCalledWith('http://evil.com/x');
    navigateClient('http://evil.com/y', { replace: true });
    expect(w.location.replace).toHaveBeenCalledWith('http://evil.com/y');
  });

  it('none-mode target does nothing', () => {
    const w = stubWindow();
    navigateClient('mailto:a@b.c');
    expect(w.history.pushState).not.toHaveBeenCalled();
    expect(w.location.assign).not.toHaveBeenCalled();
  });

  it('forces a hard reload when switching to a different workspace', () => {
    const w = stubWindow();
    (w as { __PAPERCUSP_WS__?: string }).__PAPERCUSP_WS__ = 'alpha';
    navigateClient('/harness?ws=beta');
    expect(w.location.assign).toHaveBeenCalledWith('http://localhost:3070/harness?ws=beta');
    expect(w.history.pushState).not.toHaveBeenCalled();
  });

  it('soft-navigates within the current workspace', () => {
    const w = stubWindow();
    (w as { __PAPERCUSP_WS__?: string }).__PAPERCUSP_WS__ = 'alpha';
    navigateClient('/harness/sub?ws=alpha');
    expect(w.history.pushState).toHaveBeenCalledWith({}, '', '/harness/sub?ws=alpha');
    expect(w.location.assign).not.toHaveBeenCalled();
  });
});
