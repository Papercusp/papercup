import { describe, expect, it } from 'vitest';
import { validateEmbeddableLink } from './embeddable-policy';

describe('validateEmbeddableLink', () => {
  it.each([
    'https://twitter.com/Interior/status/463440424141459456',
    'https://www.twitter.com/Interior/status/463440424141459456',
    'https://platform.twitter.com/widgets.js',
    'https://x.com/example/status/1',
    'https://mobile.x.com/example/status/1',
    'https://reddit.com/r/example/comments/1',
    'https://www.reddit.com/r/example/comments/1',
    'https://embed.reddit.com/r/example/comments/1',
    'https://reddit.com./r/example/comments/1',
  ])('rejects blocked provider URL %s', (link) => {
    expect(validateEmbeddableLink(link)).toBe(false);
  });

  it.each([
    'https://not-twitter.com/article',
    'https://twitter.com.evil.example/article',
    'https://not-x.com/article',
    'https://not-reddit.com/article',
    'https://example.com/article',
    'not a URL',
  ])('defers non-blocked URL %s to Excalidraw defaults', (link) => {
    expect(validateEmbeddableLink(link)).toBeUndefined();
  });
});
