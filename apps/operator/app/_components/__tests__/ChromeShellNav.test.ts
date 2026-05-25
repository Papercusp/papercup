/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { isChromeShellNavActive } from '../chrome-shell-nav';

describe('ChromeShell header nav helper', () => {
  it('marks exact and nested routes as active', () => {
    expect(isChromeShellNavActive('/support', '/support')).toBe(true);
    expect(isChromeShellNavActive('/support/tickets', '/support')).toBe(true);
    expect(isChromeShellNavActive('/installed/plugins/foo', '/installed/plugins')).toBe(true);
  });

  it('does not mark sibling prefixes as active', () => {
    expect(isChromeShellNavActive('/supporting', '/support')).toBe(false);
    expect(isChromeShellNavActive('/installed/plugin', '/installed/plugins')).toBe(false);
  });
});
