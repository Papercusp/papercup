/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChatwootWidget, shouldEnableChatwootForCurrentWindow } from '../ChatwootWidget';

afterEach(() => {
  cleanup();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ user: null }) })));
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

  it('enables the Chatwoot SDK policy on the non-static support host', () => {
    expect(shouldEnableChatwootForCurrentWindow({
      pathname: '/support',
      origin: 'http://localhost:3055',
    })).toBe(true);
  });
});
