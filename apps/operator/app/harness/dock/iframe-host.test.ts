/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  _registrySize,
  _resetForTests,
  attach,
  destroy,
  detach,
  getOrCreateIframe,
} from './iframe-host';

afterEach(() => _resetForTests());

describe('iframe-host', () => {
  it('creates and registers an iframe on first call', () => {
    const f = getOrCreateIframe('a', { src: 'about:blank' });
    expect(f.tagName).toBe('IFRAME');
    expect(f.dataset.iframeHostId).toBe('a');
    expect(_registrySize()).toBe(1);
  });

  it('returns the same node on subsequent calls', () => {
    const f1 = getOrCreateIframe('a', { src: 'about:blank' });
    const f2 = getOrCreateIframe('a', { src: 'about:blank' });
    expect(f1).toBe(f2);
    expect(_registrySize()).toBe(1);
  });

  it('attaches iframe into a container without destroying it', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const f = getOrCreateIframe('a', { src: 'about:blank' });
    // Set a marker on the iframe's contentWindow stand-in so we can
    // verify identity persists across attach/detach. jsdom won't load
    // about:blank's window fully but we can mark the element directly.
    (f as unknown as { __mark?: number }).__mark = 42;
    attach('a', container);
    expect(f.parentElement).toBe(container);
    expect((f as unknown as { __mark?: number }).__mark).toBe(42);
  });

  it('detach moves iframe back to off-DOM container', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const f = getOrCreateIframe('a', { src: 'about:blank' });
    attach('a', container);
    expect(f.parentElement).toBe(container);
    detach('a');
    expect(f.parentElement).not.toBe(container);
    expect(f.parentElement?.id).toBe('papercusp-iframe-host');
  });

  it('attach is idempotent when target is unchanged', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const f = getOrCreateIframe('a', { src: 'about:blank' });
    attach('a', container);
    attach('a', container);
    expect(f.parentElement).toBe(container);
    expect(container.children.length).toBe(1);
  });

  it('attach with no iframe registered is no-op (does not throw)', () => {
    const container = document.createElement('div');
    expect(() => attach('nonexistent', container)).not.toThrow();
  });

  it('destroy removes iframe and registry entry', () => {
    getOrCreateIframe('a', { src: 'about:blank' });
    expect(_registrySize()).toBe(1);
    destroy('a');
    expect(_registrySize()).toBe(0);
    // Second destroy is a no-op.
    expect(() => destroy('a')).not.toThrow();
  });

  it('sets sandbox/allow/title attributes from options', () => {
    const f = getOrCreateIframe('a', {
      src: 'about:blank',
      sandbox: 'allow-scripts',
      allow: 'clipboard-read',
      title: 'My Code',
    });
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('allow')).toBe('clipboard-read');
    expect(f.title).toBe('My Code');
  });

  it('attach → detach → attach round-trips the same DOM node', () => {
    const c1 = document.createElement('div');
    const c2 = document.createElement('div');
    document.body.append(c1, c2);
    const f = getOrCreateIframe('a', { src: 'about:blank' });
    attach('a', c1);
    expect(c1.contains(f)).toBe(true);
    detach('a');
    expect(c1.contains(f)).toBe(false);
    attach('a', c2);
    expect(c2.contains(f)).toBe(true);
    // It's the SAME element across moves — no recreate.
    expect(_registrySize()).toBe(1);
  });
});
