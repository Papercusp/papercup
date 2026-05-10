/**
 * Smoke tests for UICardRenderer + isUIResourceContent.
 */

import { describe, expect, it } from 'vitest';
import { isUIResourceContent } from './UICardRenderer';

describe('isUIResourceContent', () => {
  it('detects a valid UIResource', () => {
    const c = {
      type: 'resource',
      resource: { uri: 'ui://x/y', mimeType: 'text/html', text: '<p>hi</p>' },
    };
    expect(isUIResourceContent(c)).toBe(true);
  });

  it('rejects text content', () => {
    expect(isUIResourceContent({ type: 'text', text: 'hello' })).toBe(false);
  });

  it('rejects non-ui:// URIs', () => {
    const c = {
      type: 'resource',
      resource: {
        uri: 'papercusp://workspace/harnesses',
        mimeType: 'application/json',
        text: '{}',
      },
    };
    expect(isUIResourceContent(c)).toBe(false);
  });

  it('rejects malformed content', () => {
    expect(isUIResourceContent(null)).toBe(false);
    expect(isUIResourceContent({})).toBe(false);
    expect(isUIResourceContent({ type: 'resource' })).toBe(false);
    expect(
      isUIResourceContent({ type: 'resource', resource: { uri: 42 } }),
    ).toBe(false);
  });
});
