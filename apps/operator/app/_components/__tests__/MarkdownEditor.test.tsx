/**
 * @vitest-environment jsdom
 *
 * MarkdownEditor — wrapper tests around the (heavy, jsdom-incompatible)
 * `vditor` editor.
 *
 * Vditor is fully mocked: the real module pulls in CodeMirror/Lute/DOM
 * machinery jsdom can't run, so we substitute a tiny fake constructor that
 * records its options, drives the `after()` lifecycle hook, and exposes the
 * instance methods the wrapper calls (setValue/getValue/disabled/enable/
 * destroy). The CSS side-effect import is stubbed to a no-op.
 *
 * Covers:
 *  - The wrapper mounts (host div) and constructs Vditor with the expected
 *    config (mode, cache disabled, toolbar, lang/theme).
 *  - The initial `value` is pushed via setValue after construction.
 *  - `onChange` is surfaced when Vditor's `input` option fires.
 *  - `readOnly` calls disabled() on the instance.
 *  - expandWikiLinks (pure helper) rewrites [[wiki]] syntax.
 *
 * Uses @testing-library/react + vitest only (no jest-dom matchers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ── Vditor mock ─────────────────────────────────────────────────────────────
//
// Capture every constructed instance + the options it was built with so the
// test can assert on config and drive the `input` callback.

interface MockVditorInstance {
  element: HTMLElement;
  options: any;
  value: string;
  setValue: ReturnType<typeof vi.fn>;
  getValue: ReturnType<typeof vi.fn>;
  disabled: ReturnType<typeof vi.fn>;
  enable: ReturnType<typeof vi.fn>;
  setTheme: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const instances: MockVditorInstance[] = [];

class MockVditor {
  element: HTMLElement;
  options: any;
  value = '';
  setValue: ReturnType<typeof vi.fn>;
  getValue: ReturnType<typeof vi.fn>;
  disabled: ReturnType<typeof vi.fn>;
  enable: ReturnType<typeof vi.fn>;
  setTheme: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;

  constructor(element: HTMLElement, options: any) {
    this.element = element;
    this.options = options;
    this.setValue = vi.fn((v: string) => {
      this.value = v;
    });
    this.getValue = vi.fn(() => this.value);
    this.disabled = vi.fn();
    this.enable = vi.fn();
    this.setTheme = vi.fn();
    this.destroy = vi.fn();
    instances.push(this as unknown as MockVditorInstance);
    // Vditor calls `after()` once the editor is constructed. Fire it async
    // (microtask) to mimic the real lifecycle and let React commit first.
    Promise.resolve().then(() => {
      options.after?.();
    });
  }

  // Static API used by MarkdownPreview (not under test here, but keep it
  // safe in case the module touches it).
  static preview = vi.fn(async (
    _element?: HTMLElement,
    _value?: string,
    _options?: unknown,
  ) => {});
  static outlineRender = vi.fn(
    (_root?: HTMLElement, _outline?: HTMLElement) => {},
  );
}

vi.mock('vditor', () => ({ default: MockVditor }));
// The lazy CSS side-effect import — stub to a resolved no-op module.
vi.mock('vditor/dist/index.css', () => ({}));

// Import AFTER the mocks are registered.
import {
  MarkdownEditor,
  MarkdownPreview,
  expandWikiLinks,
  preloadVditor,
} from '../MarkdownEditor';

beforeEach(() => {
  instances.length = 0;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty('--bg');
});

describe('preloadVditor', () => {
  it('reports a completed Vditor/Lute warm-up as successful', async () => {
    await expect(preloadVditor()).resolves.toBe(true);
    expect(MockVditor.preview).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      'warm',
      expect.objectContaining({ math: { engine: 'KaTeX' } }),
    );
  });
});

describe('MarkdownEditor — mount + config', () => {
  it('renders the host container and constructs Vditor exactly once', async () => {
    const { container } = render(<MarkdownEditor value="# hello" />);
    // The wrapper host div is present immediately.
    expect(container.querySelector('.pc-md-editor-host')).toBeTruthy();
    // Vditor is constructed (async via the dynamic import()).
    await waitFor(() => expect(instances.length).toBe(1));
  });

  it('passes the expected options to Vditor (mode, cache off, toolbar, lang/theme)', async () => {
    const toolbar = ['bold', 'italic'];
    render(<MarkdownEditor value="x" mode="wysiwyg" toolbar={toolbar} />);
    await waitFor(() => expect(instances.length).toBe(1));
    const opts = instances[0].options;
    expect(opts.mode).toBe('wysiwyg');
    expect(opts.theme).toBe('dark');
    expect(opts.lang).toBe('en_US');
    // cache MUST be disabled (invariant #4 in the source).
    expect(opts.cache).toEqual({ enable: false });
    expect(opts.toolbar).toEqual(toolbar);
    expect(typeof opts.input).toBe('function');
    expect(typeof opts.after).toBe('function');
  });

  it('pushes the initial value via setValue after construction', async () => {
    render(<MarkdownEditor value="initial body" />);
    await waitFor(() => expect(instances.length).toBe(1));
    await waitFor(() =>
      expect(instances[0].setValue).toHaveBeenCalledWith('initial body'),
    );
  });
});

describe('MarkdownEditor — onChange surfacing', () => {
  it('forwards Vditor input events to the onChange prop', async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="" onChange={onChange} />);
    await waitFor(() => expect(instances.length).toBe(1));
    // Simulate the user typing — Vditor calls its `input` option with the
    // new markdown string.
    instances[0].options.input('typed text');
    expect(onChange).toHaveBeenCalledWith('typed text');
  });
});

describe('MarkdownEditor — readOnly', () => {
  it('calls disabled() on the instance when readOnly is true', async () => {
    render(<MarkdownEditor value="x" readOnly />);
    await waitFor(() => expect(instances.length).toBe(1));
    await waitFor(() => expect(instances[0].disabled).toHaveBeenCalled());
    expect(instances[0].enable).not.toHaveBeenCalled();
  });

  it('calls enable() (not disabled) when readOnly is false', async () => {
    render(<MarkdownEditor value="x" readOnly={false} />);
    await waitFor(() => expect(instances.length).toBe(1));
    await waitFor(() => expect(instances[0].enable).toHaveBeenCalled());
    expect(instances[0].disabled).not.toHaveBeenCalled();
  });
});

describe('expandWikiLinks — pure helper', () => {
  it('rewrites a bare [[wiki-link]] to a /wiki link', () => {
    expect(expandWikiLinks('see [[knowledge]] here')).toBe(
      'see [knowledge](/wiki?target=knowledge) here',
    );
  });

  it('rewrites a harness-scoped [[harness/target]] link', () => {
    expect(expandWikiLinks('[[sheets/knowledge]]')).toBe(
      '[sheets/knowledge](/wiki?target=knowledge&harness=sheets)',
    );
  });

  it('honours an explicit [[target|label]] alias', () => {
    expect(expandWikiLinks('[[supervisor-notes|notes]]')).toBe(
      '[notes](/wiki?target=supervisor-notes)',
    );
  });

  it('leaves text without wiki syntax unchanged and tolerates null/undefined', () => {
    expect(expandWikiLinks('plain text')).toBe('plain text');
    expect(expandWikiLinks(undefined as unknown as string)).toBe('');
  });
});

describe('MarkdownPreview — readable frontmatter/code styling', () => {
  it('adds the shared preview class and readable YAML/frontmatter CSS', async () => {
    const { container } = render(<MarkdownPreview value={'---\ntitle: Demo\n---\n\n# Demo'} />);

    await waitFor(() => expect(MockVditor.preview).toHaveBeenCalled());
    expect(container.querySelector('.pc-md-preview')).toBeTruthy();
    const styles = Array.from(container.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n');
    expect(styles).toContain('code.language-yaml');
    expect(styles).toContain('var(--fg, #e7f7ff)');
    expect(styles).toContain('var(--border-strong');
  });

  it('inherits the resolved host color scheme and follows live theme changes', async () => {
    document.documentElement.dataset.theme = 'portal-light';
    document.documentElement.style.setProperty('--bg', '#f4f0e8');
    render(<MarkdownPreview value="# Theme" />);

    await waitFor(() => {
      const options = MockVditor.preview.mock.calls.at(-1)?.[2] as {
        mode?: string;
        theme?: { current?: string };
      };
      expect(options.mode).toBe('light');
      expect(options.theme?.current).toBe('light');
    });

    document.documentElement.dataset.theme = 'portal-dark';
    document.documentElement.style.setProperty('--bg', '#191817');
    window.dispatchEvent(new CustomEvent('papercusp:theme-changed'));

    await waitFor(() => {
      const options = MockVditor.preview.mock.calls.at(-1)?.[2] as {
        mode?: string;
        theme?: { current?: string };
      };
      expect(options.mode).toBe('dark');
      expect(options.theme?.current).toBe('dark');
    });
  });

  it('uses semantic host tokens instead of forcing a dark preview surface', async () => {
    const { container } = render(<MarkdownPreview value="# Semantic" />);
    await waitFor(() => expect(MockVditor.preview).toHaveBeenCalled());

    expect(container.querySelector('.pc-md-preview')?.getAttribute('style')).toContain(
      'var(--bg-1',
    );
    const styles = Array.from(container.querySelectorAll('style'))
      .map((element) => element.textContent ?? '')
      .join('\n');
    expect(styles).not.toContain('#19232A');
    expect(styles).toContain('var(--fg');
    expect(styles).toContain('var(--bg-popover');
  });

  it('renders a labeled, keyboard-reachable P/D outline that scrolls the inner plan', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    MockVditor.preview.mockImplementationOnce(async (root) => {
      if (!root) return;
      root.innerHTML = [
        '<h2 id="phase">Phase 1</h2>',
        '<h3 id="p-001">P-001 Build it</h3>',
        '<h3 id="d-002">D-002 Keep it shared</h3>',
      ].join('');
    });
    MockVditor.outlineRender.mockImplementationOnce((_root, outline) => {
      if (!outline) return;
      outline.innerHTML = [
        '<ul>',
        '<li><a href="#phase" data-target-id="phase">Phase 1</a></li>',
        '<li><a href="#p-001" data-target-id="p-001">P-001 Build it</a></li>',
        '<li><a href="#d-002" data-target-id="d-002">D-002 Keep it shared</a></li>',
        '</ul>',
      ].join('');
    });

    render(<MarkdownPreview value="# Plan" outline="left" />);

    const navigation = await screen.findByRole('navigation', { name: 'Plan outline' });
    const links = Array.from(navigation.querySelectorAll('a'));
    expect(links).toHaveLength(3);
    expect(links[0]?.dataset.planOutlineKind).toBe('section');
    expect(links[1]?.dataset.planOutlineKind).toBe('item');
    expect(links[2]?.dataset.planOutlineKind).toBe('decision');
    expect(links.every((link) => link.tabIndex >= 0)).toBe(true);

    fireEvent.click(links[1]!);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'start',
      behavior: 'smooth',
    });
    expect(links[1]?.getAttribute('aria-current')).toBe('location');
  });
});

describe('VditorUnavailable fallback — stale-bundle chunk 404', () => {
  // Simulates the lazy `import('vditor')` rejecting (the bundle was rebuilt
  // underneath an open page → old chunk 404s). The wrapper must NOT dead-end at
  // a bare error: it keeps the markdown content (the `value` already in hand)
  // visible as raw text, plus a Reload affordance to upgrade to the full render.
  it('renders the raw markdown + a Reload button instead of losing the content', async () => {
    // The catch path logs `console.error('[MarkdownEditor] vditor failed…')`
    // by design; swallow it so vitest-fail-on-console doesn't flag the
    // deliberately-induced failure.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('vditor', () => {
      throw new Error('preloadError: vditor chunk 404 (bundle rebuilt)');
    });
    vi.doMock('vditor/dist/index.css', () => ({}));
    const mod = await import('../MarkdownEditor');
    const body = '# Plan body\n\n- step one\n- step two';
    const { container, getByText } = render(<mod.MarkdownEditor value={body} />);

    await waitFor(() =>
      expect(container.textContent).toContain('load the markdown renderer'),
    );
    // Content is preserved, not discarded.
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('# Plan body');
    expect(pre?.textContent).toContain('- step two');
    // The "showing raw text" hint + a working Reload button are both present.
    expect(container.textContent).toContain('showing raw text');
    expect(getByText('Reload')).toBeTruthy();
    // The induced failure was logged (and swallowed) exactly as designed.
    expect(errSpy).toHaveBeenCalled();

    vi.doUnmock('vditor');
    vi.doUnmock('vditor/dist/index.css');
    errSpy.mockRestore();
  });
});
