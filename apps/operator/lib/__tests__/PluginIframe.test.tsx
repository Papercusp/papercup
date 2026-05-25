/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { shouldSoftNavigatePluginIframe } from '../PluginIframe';

describe('PluginIframe iframe:navigate', () => {
  it('soft-navigates same-origin destinations when the origin is allowed', () => {
    expect(
      shouldSoftNavigatePluginIframe(
        'http://localhost:3070/support?ws=default',
        'http://localhost:3070/harness?ws=default',
        ['http://localhost:3070'],
      ),
    ).toBe(true);
  });

  it('does not soft-navigate cross-origin or denied destinations', () => {
    expect(
      shouldSoftNavigatePluginIframe(
        'https://example.com/docs',
        'http://localhost:3070/harness?ws=default',
        ['https://example.com'],
      ),
    ).toBe(false);
    expect(
      shouldSoftNavigatePluginIframe(
        'http://localhost:3070/support',
        'http://localhost:3070/harness?ws=default',
        ['https://example.com'],
      ),
    ).toBe(false);
    expect(
      shouldSoftNavigatePluginIframe(
        'javascript:alert(1)',
        'http://localhost:3070/harness?ws=default',
        ['*'],
      ),
    ).toBe(false);
  });
});
