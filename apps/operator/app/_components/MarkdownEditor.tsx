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
import 'vditor/dist/index.css';

export type MarkdownEditorMode = 'ir' | 'wysiwyg' | 'sv';

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
  toolbar?: Array<string | object>;
  /** Show Vditor's built-in document outline panel (left or right). */
  outline?: false | 'left' | 'right';
  /** Forwarded as a className on the outer wrapper. */
  className?: string;
  /** Inline style on the outer wrapper. */
  style?: React.CSSProperties;
  placeholder?: string;
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
}: {
  value: string;
  outline?: boolean | 'left' | 'right';
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;
    (async () => {
      const Vditor = (await import('vditor')).default;
      if (cancelled || !ref.current) return;
      await Vditor.preview(ref.current, expandWikiLinks(value ?? ''), {
        mode: 'dark',
        theme: { current: 'dark' },
        math: { engine: 'KaTeX' },
        anchor: 1,
        lang: 'en_US',
      });
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
    })();
    return () => { cancelled = true; };
  }, [value, outline]);

  if (outline) {
    const position = outline === 'right' ? 'right' : 'left';
    return (
      <div className={className} style={{ display: 'flex', gap: 16, ...style }}>
        {position === 'left' && (
          <div ref={outlineRef} className="pc-md-outline" style={outlinePanelStyle} />
        )}
        <div
          ref={ref}
          className="vditor-reset pc-md-preview"
          style={{ flex: 1, background: 'var(--bg-1, #0b0d10)', color: 'var(--text-1, #e6e6e6)', minWidth: 0 }}
        />
        {position === 'right' && (
          <div ref={outlineRef} className="pc-md-outline" style={outlinePanelStyle} />
        )}
        <style>{`
          .pc-md-outline ul { list-style: none; padding-left: 12px; margin: 0; }
          .pc-md-outline > ul { padding-left: 0; }
          .pc-md-outline li { margin: 2px 0; }
          .pc-md-outline a { color: var(--text-2, #aaa); text-decoration: none; font-size: 12px; line-height: 1.5; display: block; padding: 1px 4px; border-radius: 2px; }
          .pc-md-outline a:hover { color: var(--text-1, #fff); background: var(--bg-2, #15181c); }
        `}</style>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={`vditor-reset ${className ?? ''}`}
      style={{ background: 'var(--bg-1, #0b0d10)', color: 'var(--text-1, #e6e6e6)', ...style }}
    />
  );
}

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

const DEFAULT_TOOLBAR: Array<string | object> = [
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
}: MarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialValueRef = useRef(value);
  const [ready, setReady] = useState(false);

  // Mount: deps are config-only so value changes don't remount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
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
        },
      });
    })();
    return () => {
      cancelled = true;
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

  return (
    <>
      <style>{`
        /* Vditor mounts INTO the container element and adds .vditor class names
         * to it. To get internal scrolling instead of vertical-overflow, we
         * override Vditor's inline height with !important. The .vditor-ir
         * element is the scroll container — Vditor's outline click handler
         * does \`vditor.ir.element.scrollTop = …\`, so .vditor-ir MUST be the
         * overflow:auto layer (not its inner <pre>) for outline links to work. */
        .pc-md-editor-host.vditor { display: flex !important; flex-direction: column !important; height: 100% !important; min-height: 0; }
        .pc-md-editor-host.vditor > .vditor-toolbar { flex: 0 0 auto; }
        .pc-md-editor-host.vditor > .vditor-content { flex: 1 1 0 !important; min-height: 0 !important; display: flex !important; overflow: hidden !important; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-outline { flex: 0 0 auto; max-width: 240px; overflow: auto; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-ir,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-wysiwyg,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-sv { flex: 1 1 0 !important; min-height: 0 !important; overflow: auto !important; background-color: var(--textarea-background-color) !important; }
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
