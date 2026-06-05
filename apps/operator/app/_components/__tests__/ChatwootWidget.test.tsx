/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const shouldEnableSupportWidget = vi.fn();

vi.mock('@papercusp/operator-core/lib/ui/desktop-static-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/operator-core/lib/ui/desktop-static-host')>();
  return {
    ...actual,
    shouldEnableSupportWidget: (...args: unknown[]) => shouldEnableSupportWidget(...args),
  };
});

import { ChatwootWidget, shouldEnableChatwootForCurrentWindow } from '../ChatwootWidget';

afterEach(() => {
  cleanup();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  shouldEnableSupportWidget.mockReset();
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ user: null }) })));
  shouldEnableSupportWidget.mockReturnValue(false);
});

describe('ChatwootWidget', () => {
  it('does not inject the Chatwoot SDK on static desktop hosts', () => {
    expect(shouldEnableChatwootForCurrentWindow({
      pathname: '/support',
      origin: 'http://localhost:3070',
    })).toBe(false);
    render(<ChatwootWidget />);
    expect(document.querySelector('script[src*="chat.papercupai.com/packs/js/sdk.js"]')).toBeNull();
  });
  it('stays suppressed on static desktop hosts even after support-open events', () => {
    render(<ChatwootWidget />);

    window.dispatchEvent(new CustomEvent('papercusp:open-support'));

    expect(document.querySelector('script[src*="chat.papercupai.com/packs/js/sdk.js"]')).toBeNull();
  });


  it('enables the Chatwoot SDK policy on the non-static support host', () => {
    shouldEnableSupportWidget.mockReturnValue(true);
    expect(shouldEnableChatwootForCurrentWindow({
      pathname: '/support',
      origin: 'http://localhost:3055',
    })).toBe(true);
  });
  it('injects the Chatwoot SDK when the host policy allows it', () => {
    shouldEnableSupportWidget.mockReturnValue(true);

    render(<ChatwootWidget />);

    expect(document.querySelector('script[src*="chat.papercupai.com/packs/js/sdk.js"]')).not.toBeNull();
  });
});
