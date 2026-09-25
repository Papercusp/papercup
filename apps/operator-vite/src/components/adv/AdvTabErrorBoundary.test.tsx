// @vitest-environment jsdom
/**
 * AdvTabErrorBoundary.test — the /adv per-tab crash isolation (2026-07-11). A
 * render throw in a tab body must degrade to a fallback, NOT propagate to the
 * root and white-screen the operator. Covers: pass-through on success, fallback
 * (with the error message + tab name) on a throw, and that the throw is swallowed
 * (a sibling rendered next to the boundary still shows).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AdvTabErrorBoundary from './AdvTabErrorBoundary';
import { resetRenderCrashReportDedupForTest } from '../../lib/render-crash-report';

function Boom(): never {
  throw new Error('kaboom: item.id of undefined');
}

// React logs caught render errors to console.error; silence the expected noise
// so the suite output stays clean, while still asserting OUR componentDidCatch fired.
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errSpy.mockRestore(); cleanup(); vi.unstubAllGlobals(); resetRenderCrashReportDedupForTest(); });

describe('AdvTabErrorBoundary', () => {
  it('renders children unchanged when they do not throw', () => {
    render(
      <AdvTabErrorBoundary tab="overview">
        <div data-testid="tab-body">all good</div>
      </AdvTabErrorBoundary>,
    );
    expect(screen.getByTestId('tab-body')).toBeTruthy();
    expect(screen.queryByTestId('adv-tab-error')).toBeNull();
  });

  it('shows the fallback (with tab name + error message) when a child throws', () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AdvTabErrorBoundary tab="plans">
        <Boom />
      </AdvTabErrorBoundary>,
    );
    const fallback = screen.getByTestId('adv-tab-error');
    expect(fallback).toBeTruthy();
    expect(fallback.textContent).toContain('plans');
    expect(fallback.textContent).toContain('kaboom: item.id of undefined');
    // componentDidCatch logged the crash (the shell survives, so this is the signal).
    expect(errSpy).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/api/desktop/telemetry-report', expect.objectContaining({ method: 'POST' }));
  });

  it('swallows the throw so a sibling outside the boundary still renders', () => {
    render(
      <div>
        <AdvTabErrorBoundary tab="plans">
          <Boom />
        </AdvTabErrorBoundary>
        <div data-testid="shell-chrome">agents popup lives here</div>
      </div>,
    );
    // The boundary caught the throw → the sibling (mimicking the shell chrome that
    // hosts AgentsRunningPill) is unaffected.
    expect(screen.getByTestId('shell-chrome')).toBeTruthy();
    expect(screen.getByTestId('adv-tab-error')).toBeTruthy();
  });
});
