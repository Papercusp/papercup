'use client';

/**
 * Vditor-backed markdown editor used across the operator's editing surfaces.
 *
 * Lifecycle invariants (the four sharp edges of any Vditor wrapper):
 *  1. Mount-effect deps are config-only — value updates never remount the editor.
 *  2. External value changes go through setValue + scroll/cursor preservation.
 *  3. `disabled` is its own effect; toggling it never recreates the instance.
 *  4. `cache: { enable: false }` so Vditor's localStorage cache doesn't mask updates.
 */

import { useEffect, useRef, useState } from 'react';
import { hardReload } from '@papercusp/operator-core/lib/hard-reload';

/**
 * Inline fallback when the lazy `import('vditor')` chunk fails to load — which
 * happens when the bundle was rebuilt underneath an open page (`vite build
 * --watch` rewrites `dist/`, so the running page references a now-404'd chunk).
 * Without this the markdown pane just renders blank ("config tab not loading
 * markdown via vditor"). The global ChunkReloadPrompt also fires on the
 * `vite:preloadError`, but an inline notice with a working reload is clearer at
 * the point of use.
 */
function VditorUnavailable({
  style,
  className,
  raw,
}: {
  style?: React.CSSProperties;
  className?: string;
  /**
   * The markdown source the failed renderer would have shown. When present we
   * render it as readable preformatted text BELOW the notice, so a stale page
   * (rebuilt-bundle chunk 404) still shows the plan/doc content instead of
   * dead-ending — the Reload button upgrades to the full rendered view. The
   * content is already in hand (the `value` prop); the only thing the 404 took
   * away is the pretty renderer, not the text.
   */
  raw?: string;
}) {
  const hasRaw = typeof raw === 'string' && raw.trim().length > 0;
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 120,
        fontSize: 13,
        color: 'var(--fg-mute, #7f9bb4)',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: hasRaw ? '8px 12px' : 16,
          textAlign: 'center',
          borderBottom: hasRaw
            ? '1px solid var(--border, rgba(125,211,252,0.18))'
            : undefined,
        }}
      >
        <span>
          Couldn&rsquo;t load the markdown renderer
          {hasRaw ? ' — showing raw text. ' : '. '}
          <span style={{ fontSize: 12 }}>
            The app was likely updated underneath this page.
          </span>
        </span>
        <button
          type="button"
          onClick={() => hardReload()}
          style={{
            padding: '4px 14px',
            fontSize: 12,
            fontWeight: 600,
            color: '#06121b',
            background: 'var(--accent, #57d7ff)',
            border: 0,
            borderRadius: 6,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          Reload
        </button>
      </div>
      {hasRaw && (
        <pre
          style={{
            flex: 1,
            minHeight: 0,
            margin: 0,
            padding: 16,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--fg, #e6e6e6)',
            background: '#19232A',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          }}
        >
          {raw}
        </pre>
      )}
    </div>
  );
}

// Vditor's CSS (~45 KB / 302 rules) is loaded lazily alongside the editor
// JS. Importing it at module level pulls the whole stylesheet into every
// bundle that imports anything from this file — including consumers that
// only use the lightweight `MarkdownPreview` (banner/toast/support panels)
// and never instantiate Vditor. Diagnostic 2026-05-06: the dashboard had
// 302 vditor-* CSS rules loaded but 0 vditor DOM elements.
//
// Implementation: mounted by `loadVditorCss()` below, called once before
// the first `new Vditor(...)`. Uses `import()` so Turbopack/webpack code-
// split it into its own CSS chunk and load on demand.
let _vditorCssPromise: Promise<unknown> | null = null;
function loadVditorCss(): Promise<unknown> {
  if (!_vditorCssPromise) _vditorCssPromise = import('vditor/dist/index.css');
  return _vditorCssPromise;
}

export type MarkdownEditorMode = 'ir' | 'wysiwyg' | 'sv';
type VditorOptions = NonNullable<ConstructorParameters<typeof import('vditor').default>[1]>;
export type MarkdownEditorToolbar = NonNullable<VditorOptions['toolbar']>;


export interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  mode?: MarkdownEditorMode;
  readOnly?: boolean;
  /** CSS height for the editor container. Defaults to 100% of parent. */
  height?: number | string;
  /** Min height for `ir`/`wysiwyg` modes. Vditor ignores this in `sv`. */
  minHeight?: number;
  /** Override the default toolbar config. Pass [] for no toolbar. */
  toolbar?: MarkdownEditorToolbar;
  /** Show Vditor's built-in document outline panel (left or right). */
  outline?: false | 'left' | 'right';
  /** Forwarded as a className on the outer wrapper. */
  className?: string;
  /** Inline style on the outer wrapper. */
  style?: React.CSSProperties;
  placeholder?: string;
  /**
   * Fires once after the editor is fully constructed and the initial value
   * has been set. Receives the live Vditor instance. Use for surfaces that
   * need to register Lute renderers (`vditor.lute.SetJSRenderers(...)`) or
   * attach delegated event handlers to the editor element. Called with
   * `null` on unmount/destroy.
   */
  onInstance?: (instance: any | null) => void;
}

/**
 * Pre-process Obsidian-style `[[wiki-link]]` syntax into standard markdown
 * links pointing at `/wiki?target=...`. Applied in <MarkdownPreview> only;
 * editor surfaces show `[[X]]` as literal text.
 *
 *   [[knowledge]]              → [knowledge](/wiki?target=knowledge)
 *   [[sheets/knowledge]]       → [sheets/knowledge](/wiki?target=knowledge&harness=sheets)
 *   [[supervisor-notes|notes]] → [notes](/wiki?target=supervisor-notes)
 */
export function expandWikiLinks(md: string): string {
  return (md ?? '').replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, raw, label) => {
    const t = raw.trim();
    let target = t;
    let harness: string | null = null;
    const slash = t.indexOf('/');
    if (slash > 0) {
      harness = t.slice(0, slash);
      target = t.slice(slash + 1);
    }
    const display = (label ?? t).trim();
    const params = new URLSearchParams({ target });
    if (harness) params.set('harness', harness);
    return `[${display}](/wiki?${params.toString()})`;
  });
}

/**
 * Read-only renderer for markdown — uses Vditor's static `preview()` API,
 * which renders Mermaid / KaTeX / PlantUML / Echarts / flowchart inline
 * without instantiating a full editor. Drop-in replacement for
 * `<ReactMarkdown>{md}</ReactMarkdown>`. Also expands [[wiki-links]].
 *
 * @param outline When true or 'left'/'right', renders a sticky table-of-contents
 *                panel beside the rendered content using `Vditor.outlineRender`.
 */
export function MarkdownPreview({
  value,
  outline = false,
  className,
  style,
  renderers,
  onParsed,
}: {
  value: string;
  outline?: boolean | 'left' | 'right';
  className?: string;
  style?: React.CSSProperties;
  /**
   * Lute custom renderers, passed straight through to Vditor.preview's
   * documented `renderers: ILuteRender` option (per-construct overrides
   * like renderCodeSpan / renderListItem / renderText). Typed loosely
   * because vditor does not publish ILuteRender in its public types.
   * Read via ref so callers don't need to memoize.
   */
  renderers?: Record<string, unknown>;
  /**
   * Fired once with the rendered DOM after each Vditor.preview() call.
   * Used by post-render decorators (Plans admin, P-106) for DOM-walking
   * passes that don't fit the renderer protocol. Read via ref so
   * callers don't need to memoize.
   */
  onParsed?: (root: HTMLElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  const renderersRef = useRef(renderers);
  renderersRef.current = renderers;
  const onParsedRef = useRef(onParsed);
  onParsedRef.current = onParsed;
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;
    setLoadError(false);
    (async () => {
      await loadVditorCss();
      const Vditor = (await import('vditor')).default;
      if (cancelled || !ref.current) return;
      const previewOpts: Record<string, unknown> = {
        mode: 'dark',
        theme: { current: 'dark' },
        math: { engine: 'KaTeX' },
        anchor: 1,
        lang: 'en_US',
      };
      if (renderersRef.current) previewOpts.renderers = renderersRef.current;
      await Vditor.preview(ref.current, expandWikiLinks(value ?? ''), previewOpts as never);
      if (cancelled || !ref.current) return;
      try { onParsedRef.current?.(ref.current); } catch { /* decorator errors don't fail render */ }
      if (outline && outlineRef.current && ref.current) {
        outlineRef.current.innerHTML = '';
        Vditor.outlineRender(ref.current, outlineRef.current);
        // Vditor's standalone outlineRender attaches a click handler that does
        // `window.scrollTo(0, idElement.offsetTop)` — but our preview lives inside
        // a flex container with its own overflow, so window-level scroll is wrong.
        // Intercept and scrollIntoView() the heading instead so it scrolls
        // whichever ancestor is actually scrollable.
        const onClick = (event: Event) => {
          let t = event.target as HTMLElement | null;
          while (t && t !== outlineRef.current) {
            const tid = t.getAttribute?.('data-target-id');
            if (tid) {
              const heading = ref.current?.querySelector(`#${CSS.escape(tid)}`) as HTMLElement | null;
              if (heading) {
                event.preventDefault();
                event.stopPropagation();
                heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }
              return;
            }
            t = t.parentElement;
          }
        };
        outlineRef.current.addEventListener('click', onClick, true);
      }
    })().catch((err: unknown) => {
      if (cancelled) return;
      // The lazy vditor chunk 404'd (bundle rebuilt underneath the page).
      // Surface a reload affordance instead of a silently blank pane.
      setLoadError(true);
      // eslint-disable-next-line no-console
      console.error('[MarkdownPreview] vditor failed to load:', err);
    });
    return () => { cancelled = true; };
  }, [value, outline]);

  if (loadError) {
    return <VditorUnavailable className={className} style={style} raw={value} />;
  }

  if (outline) {
    const position = outline === 'right' ? 'right' : 'left';
    return (
      <div className={className} style={{ display: 'flex', gap: 16, background: '#19232A', ...style }}>
        {position === 'left' && (
          <div ref={outlineRef} className="pc-md-outline" style={outlinePanelStyle} />
        )}
        <div
          ref={ref}
          className="vditor-reset pc-md-preview"
          style={{ flex: 1, background: '#19232A', color: '#e6e6e6', minWidth: 0 }}
        />
        {position === 'right' && (
          <div ref={outlineRef} className="pc-md-outline" style={outlinePanelStyle} />
        )}
        <style>{`
          .pc-md-outline ul { list-style: none; padding-left: 12px; margin: 0; }
          .pc-md-outline > ul { padding-left: 0; }
          .pc-md-outline li { margin: 2px 0; }
          .pc-md-outline a { color: #aaa; text-decoration: none; font-size: 12px; line-height: 1.5; display: block; padding: 1px 4px; border-radius: 2px; }
          .pc-md-outline a:hover { color: #fff; background: #232E37; }
          .pc-md-preview, .pc-md-preview pre, .pc-md-preview code { background-color: #19232A !important; }
          ${markdownPreviewReadableCodeCss}
        `}</style>
      </div>
    );
  }

  return (
    <>
      <div
        ref={ref}
        className={`vditor-reset pc-md-preview ${className ?? ''}`}
        style={{ background: '#19232A', color: '#e6e6e6', ...style }}
      />
      <style>{markdownPreviewReadableCodeCss}</style>
    </>
  );
}

const markdownPreviewReadableCodeCss = `
  .pc-md-preview :is(pre, pre code) {
    background: color-mix(in srgb, var(--bg-popover, #0d1829), transparent 6%) !important;
    color: var(--fg, #e7f7ff) !important;
  }
  .pc-md-preview pre {
    border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32)) !important;
    border-radius: 12px !important;
  }
  .pc-md-preview :is(code.language-yaml, code.language-yml, code.language-frontmatter, pre code:first-child) {
    color: var(--fg, #e7f7ff) !important;
  }
  .pc-md-preview :is(.hljs-attr, .hljs-attribute, .hljs-keyword, .hljs-meta) {
    color: var(--accent-strong, #7dd3fc) !important;
  }
  .pc-md-preview :is(.hljs-string, .hljs-literal, .hljs-number) {
    color: var(--fg-dim, #b9d4e8) !important;
  }
`;

const outlinePanelStyle: React.CSSProperties = {
  // Override Vditor's default `.vditor-outline { display: none }` — outlineRender
  // adds that class to whatever element it renders into.
  display: 'block',
  width: 220,
  flexShrink: 0,
  position: 'sticky',
  top: 0,
  alignSelf: 'flex-start',
  maxHeight: 'calc(100vh - 100px)',
  overflowY: 'auto',
  padding: '8px 4px',
  borderRight: '1px solid var(--border, #2a2a2a)',
};

const DEFAULT_TOOLBAR: MarkdownEditorToolbar = [
  'headings', 'bold', 'italic', 'strike', '|',
  'list', 'ordered-list', 'check', 'quote', '|',
  'code', 'inline-code', 'link', 'table', '|',
  'edit-mode', 'preview', 'outline', 'export',
];

export function MarkdownEditor({
  value,
  onChange,
  mode = 'ir',
  readOnly = false,
  height = '100%',
  minHeight = 200,
  toolbar = DEFAULT_TOOLBAR,
  outline = false,
  className,
  style,
  placeholder,
  onInstance,
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onInstanceRef = useRef(onInstance);
  onInstanceRef.current = onInstance;
  const initialValueRef = useRef(value);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Mount: deps are config-only so value changes don't remount.
  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    (async () => {
      await loadVditorCss();
      const Vditor = (await import('vditor')).default;
      if (cancelled || !containerRef.current) return;
      const inst = new Vditor(containerRef.current, {
        mode,
        theme: 'dark',
        lang: 'en_US',
        cache: { enable: false },
        undoDelay: 0,
        minHeight,
        placeholder,
        toolbar,
        outline: outline ? { enable: true, position: outline } : { enable: false, position: 'left' },
        preview: {
          theme: { current: 'dark' },
          math: { engine: 'KaTeX' },
        },
        input: (next: string) => onChangeRef.current?.(next),
        after: () => {
          if (cancelled) return;
          editorRef.current = inst;
          inst.setValue(initialValueRef.current ?? '');
          if (readOnly) inst.disabled();
          else inst.enable();
          // `outline.enable: true` mounts the DOM but Vditor leaves it
          // display:none after layout; force-show on the next frame so we
          // run after Vditor's own post-mount layout pass.
          //
          // Also install a click handler that scrolls the IR pane explicitly:
          // Vditor's built-in handler is bound on first render, gets re-run
          // unreliably across HMR / setValue paths, and the scroll math
          // assumes the editor is the document scroll layer (not always true
          // once we constrain it to a container).
          if (outline) {
            const wireOutline = () => {
              const panel = containerRef.current?.querySelector('.vditor-outline') as HTMLElement | null;
              if (!panel) return;
              panel.style.display = 'block';
              if (panel.dataset.pcOutlineWired) return;
              panel.dataset.pcOutlineWired = '1';
              panel.addEventListener('click', (event) => {
                let t = event.target as HTMLElement | null;
                while (t && t !== panel) {
                  const tid = t.getAttribute?.('data-target-id');
                  if (tid) {
                    const heading = containerRef.current?.querySelector(`#${CSS.escape(tid)}`) as HTMLElement | null;
                    if (heading) {
                      event.preventDefault();
                      event.stopPropagation();
                      heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
                    }
                    return;
                  }
                  t = t.parentElement;
                }
              }, true);
            };
            requestAnimationFrame(() => requestAnimationFrame(wireOutline));
            setTimeout(wireOutline, 100);
            setTimeout(wireOutline, 400);
          }
          setReady(true);
          try { onInstanceRef.current?.(inst); } catch { /* consumer error shouldn't abort mount */ }
        },
      });
    })().catch((err: unknown) => {
      if (cancelled) return;
      // The lazy vditor chunk 404'd (bundle rebuilt underneath the page).
      // Surface a reload affordance instead of a silently empty editor.
      setLoadError(true);
      // eslint-disable-next-line no-console
      console.error('[MarkdownEditor] vditor failed to load:', err);
    });
    return () => {
      cancelled = true;
      try { onInstanceRef.current?.(null); } catch { /* ignore */ }
      try { editorRef.current?.destroy(); } catch { /* destroy after unmount race */ }
      editorRef.current = null;
      setReady(false);
    };
    // Only remount on config-shape changes, never on value/onChange/readOnly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, JSON.stringify(toolbar)]);

  // External value updates: setValue with scroll/cursor preservation.
  useEffect(() => {
    if (!ready || !editorRef.current) return;
    const inst = editorRef.current;
    const current = inst.getValue();
    if (current === value) return;
    const sx = window.scrollX, sy = window.scrollY;
    const focused = !!containerRef.current?.contains(document.activeElement);
    inst.setValue(value ?? '');
    if (!focused) {
      requestAnimationFrame(() => window.scrollTo(sx, sy));
    }
  }, [value, ready]);

  // Disabled toggle without remount.
  useEffect(() => {
    if (!ready || !editorRef.current) return;
    if (readOnly) editorRef.current.disabled();
    else editorRef.current.enable();
  }, [readOnly, ready]);

  if (loadError) {
    return (
      <VditorUnavailable
        className={className}
        style={{ height, ...style }}
        raw={value}
      />
    );
  }

  return (
    <>
      <style>{`
        /* Vditor mounts INTO the container element and adds .vditor class names
         * to it. To get internal scrolling instead of vertical-overflow, we
         * override Vditor's inline height with !important. The .vditor-ir
         * element is the scroll container — Vditor's outline click handler
         * does \`vditor.ir.element.scrollTop = …\`, so .vditor-ir MUST be the
         * overflow:auto layer (not its inner <pre>) for outline links to work. */
        /* Use the darker blue-tinted gray (#19232A) that the user identified
         * from the screenshot as the preferred tone. Vditor's default dark
         * theme bleeds the lighter greenish-gray (#26-282E ~ #262D32) into
         * scrolled regions. Apply uniformly so scroll never reveals a delta. */
        .pc-md-editor-host.vditor--dark {
          --panel-background-color: #19232A !important;
          --toolbar-background-color: #19232A !important;
          --textarea-background-color: #19232A !important;
          background-color: #19232A !important;
        }
        .pc-md-editor-host.vditor--dark .vditor-content,
        .pc-md-editor-host.vditor--dark .vditor-ir,
        .pc-md-editor-host.vditor--dark .vditor-wysiwyg,
        .pc-md-editor-host.vditor--dark .vditor-sv,
        .pc-md-editor-host.vditor--dark .vditor-reset,
        .pc-md-editor-host.vditor--dark .vditor-outline,
        .pc-md-editor-host.vditor--dark .vditor-toolbar {
          background-color: #19232A !important;
        }
        .pc-md-editor-host.vditor { display: flex !important; flex-direction: column !important; height: 100% !important; min-height: 0; }
        .pc-md-editor-host.vditor > .vditor-toolbar { flex: 0 0 auto; }
        .pc-md-editor-host.vditor > .vditor-content { flex: 1 1 0 !important; min-height: 0 !important; display: flex !important; overflow: hidden !important; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-outline { flex: 0 0 auto; max-width: 240px; overflow: auto; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-ir,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-wysiwyg,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-sv { flex: 1 1 0 !important; min-height: 0 !important; overflow: auto !important; background-color: var(--bg-2) !important; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-ir > pre,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-wysiwyg > pre,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-sv > pre { overflow: visible !important; min-height: 100%; box-sizing: border-box; }
      `}</style>
      <div
        ref={containerRef}
        className={`pc-md-editor-host ${className ?? ''}`}
        style={{ height, width: '100%', minHeight: 0, ...style }}
      />
    </>
  );
}

export default MarkdownEditor;
