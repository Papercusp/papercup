// @vitest-environment jsdom
/**
 * AriaLiveRegions — the a11y mirror of the TTS path (v4 §2j): two hidden
 * live regions that screen readers announce in sync with spoken output.
 * aria-live-bus.test.ts covers the bus itself; this mounts the component
 * and pins the DOM contract — region roles/aria-live attributes, routing
 * by priority, last-write-wins per region, independence of the two
 * regions, and that unmount unsubscribes (no late setState).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { AriaLiveRegions } from './AriaLiveRegions';
import { publishAriaLive } from './aria-live-bus';

afterEach(cleanup);

const polite = () => document.getElementById('voice-aria-polite');
const assertive = () => document.getElementById('voice-aria-assertive');

describe('AriaLiveRegions', () => {
  it('renders both hidden regions with the SR contract (role + aria-live)', () => {
    render(<AriaLiveRegions />);
    expect(polite()).toBeTruthy();
    expect(polite()!.getAttribute('aria-live')).toBe('polite');
    expect(polite()!.getAttribute('role')).toBe('status');
    expect(assertive()).toBeTruthy();
    expect(assertive()!.getAttribute('aria-live')).toBe('assertive');
    expect(assertive()!.getAttribute('role')).toBe('alert');
    expect(polite()!.textContent).toBe('');
    expect(assertive()!.textContent).toBe('');
  });

  it('routes published text to the region matching its priority', () => {
    render(<AriaLiveRegions />);
    act(() => publishAriaLive('polite', 'suggestion arrived'));
    expect(polite()!.textContent).toBe('suggestion arrived');
    expect(assertive()!.textContent).toBe('');
    act(() => publishAriaLive('assertive', 'budget warning'));
    expect(assertive()!.textContent).toBe('budget warning');
    expect(polite()!.textContent).toBe('suggestion arrived'); // untouched
  });

  it('last write wins within a region', () => {
    render(<AriaLiveRegions />);
    act(() => publishAriaLive('polite', 'first'));
    act(() => publishAriaLive('polite', 'second'));
    expect(polite()!.textContent).toBe('second');
  });

  it('unmount unsubscribes — a later publish is a silent no-op', () => {
    const { unmount } = render(<AriaLiveRegions />);
    act(() => publishAriaLive('polite', 'before unmount'));
    unmount();
    // Would warn/throw via setState-on-unmounted if the effect cleanup
    // didn't unsubscribe; the suite's fail-on-console setup makes any
    // such warning a test failure.
    act(() => publishAriaLive('polite', 'after unmount'));
    act(() => publishAriaLive('assertive', 'after unmount'));
    expect(document.getElementById('voice-aria-polite')).toBeNull();
  });
});
