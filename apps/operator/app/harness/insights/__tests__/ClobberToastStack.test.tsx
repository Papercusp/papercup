// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ClobberToastStack } from '../ClobberToastStack';

afterEach(() => cleanup());

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, EventListener>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string, _listener: EventListener) {
    this.listeners.delete(type);
  }
  close() {
    this.closed = true;
  }
  dispatch(type: string, data: unknown) {
    const handler = this.listeners.get(type);
    if (handler) handler(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

function clobberWire(opts: { table?: string; hbKey?: string; observedAt: number; theirsPubkey?: string }) {
  return {
    table: opts.table ?? 'queue',
    hbKey: opts.hbKey ?? '1/F-1',
    observedAt: opts.observedAt,
    my: { pubkey: 'me', ts: opts.observedAt - 100 },
    theirs: { pubkey: opts.theirsPubkey ?? 'remote-aaaa-bbbb-cccc', ts: opts.observedAt },
  };
}

describe('ClobberToastStack', () => {
  it('renders nothing when no events have arrived', () => {
    FakeEventSource.instances = [];
    render(
      <ClobberToastStack
        slug="sheets"
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
      />,
    );
    expect(screen.queryByTestId('clobber-toast-stack')).toBeFalsy();
  });

  it('opens an EventSource at /api/harness/:slug/clobber-stream', () => {
    FakeEventSource.instances = [];
    render(
      <ClobberToastStack
        slug="sheets"
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
      />,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/api/harness/sheets/clobber-stream');
  });

  it('url-encodes the slug', () => {
    FakeEventSource.instances = [];
    render(
      <ClobberToastStack
        slug="a/b"
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
      />,
    );
    expect(FakeEventSource.instances[0].url).toBe('/api/harness/a%2Fb/clobber-stream');
  });

  it('renders a toast when a clobber event arrives', () => {
    FakeEventSource.instances = [];
    render(
      <ClobberToastStack
        slug="sheets"
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
      />,
    );
    act(() => {
      FakeEventSource.instances[0].dispatch('clobber', clobberWire({ observedAt: 1000 }));
    });
    expect(screen.getByTestId('clobber-toast-stack')).toBeTruthy();
    expect(screen.getByTestId('clobber-toast-queue/1/F-1/1000')).toBeTruthy();
  });

  it('caps the stack at the configured max', () => {
    FakeEventSource.instances = [];
    render(
      <ClobberToastStack
        slug="sheets"
        max={2}
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
      />,
    );
    const fes = FakeEventSource.instances[0];
    act(() => {
      fes.dispatch('clobber', clobberWire({ hbKey: '1/A', observedAt: 1 }));
      fes.dispatch('clobber', clobberWire({ hbKey: '1/B', observedAt: 2 }));
      fes.dispatch('clobber', clobberWire({ hbKey: '1/C', observedAt: 3 }));
    });
    // Only the last 2 should render.
    expect(screen.queryByTestId('clobber-toast-queue/1/A/1')).toBeFalsy();
    expect(screen.queryByTestId('clobber-toast-queue/1/B/2')).toBeTruthy();
    expect(screen.queryByTestId('clobber-toast-queue/1/C/3')).toBeTruthy();
  });

  it('dedups by event id (same table+hbKey+observedAt)', () => {
    FakeEventSource.instances = [];
    render(
      <ClobberToastStack
        slug="sheets"
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
      />,
    );
    const fes = FakeEventSource.instances[0];
    act(() => {
      fes.dispatch('clobber', clobberWire({ observedAt: 1 }));
      fes.dispatch('clobber', clobberWire({ observedAt: 1 }));
    });
    const stack = screen.getByTestId('clobber-toast-stack');
    expect(stack.children).toHaveLength(1);
  });

  it('dismiss callback removes the toast', () => {
    FakeEventSource.instances = [];
    render(
      <ClobberToastStack
        slug="sheets"
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
      />,
    );
    act(() => {
      FakeEventSource.instances[0].dispatch('clobber', clobberWire({ observedAt: 1 }));
    });
    const dismissBtn = screen.getByTestId('clobber-toast-stack').querySelector(
      '[data-testid^="clobber-dismiss-"]',
    ) as HTMLElement;
    expect(dismissBtn).toBeTruthy();
    act(() => {
      fireEvent.click(dismissBtn);
    });
    expect(screen.queryByTestId('clobber-toast-stack')).toBeFalsy();
  });

  it('drops malformed wire payloads silently', () => {
    FakeEventSource.instances = [];
    render(
      <ClobberToastStack
        slug="sheets"
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
      />,
    );
    const fes = FakeEventSource.instances[0];
    act(() => {
      // Send invalid JSON via dispatch fake — emulate by hand
      const handler = fes.listeners.get('clobber');
      if (handler) handler(new MessageEvent('clobber', { data: '{not json' }));
    });
    expect(screen.queryByTestId('clobber-toast-stack')).toBeFalsy();
  });

  it('closes the EventSource on unmount', () => {
    FakeEventSource.instances = [];
    const { unmount } = render(
      <ClobberToastStack
        slug="sheets"
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
      />,
    );
    expect(FakeEventSource.instances[0].closed).toBe(false);
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('resolveContributor maps the pubkey to a display name', () => {
    FakeEventSource.instances = [];
    render(
      <ClobberToastStack
        slug="sheets"
        EventSourceCtor={FakeEventSource as unknown as typeof EventSource}
        resolveContributor={(p) => `User<${p}>`}
      />,
    );
    act(() => {
      FakeEventSource.instances[0].dispatch(
        'clobber',
        clobberWire({ observedAt: 1, theirsPubkey: 'aaa' }),
      );
    });
    expect(screen.getByTestId('clobber-toast-stack').textContent).toContain('User<aaa>');
  });
});
