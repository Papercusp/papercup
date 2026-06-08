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
import { cleanup, render, waitFor } from '@testing-library/react';

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
  static preview = vi.fn(async () => {});
  static outlineRender = vi.fn();
}

vi.mock('vditor', () => ({ default: MockVditor }));
// The lazy CSS side-effect import — stub to a resolved no-op module.
vi.mock('vditor/dist/index.css', () => ({}));

// Import AFTER the mocks are registered.
import { MarkdownEditor, MarkdownPreview, expandWikiLinks } from '../MarkdownEditor';

beforeEach(() => {
  instances.length = 0;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});
