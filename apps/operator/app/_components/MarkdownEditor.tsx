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
 */
export function MarkdownPreview({
  value,
  className,
  style,
}: {
  value: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;
    (async () => {
      const Vditor = (await import('vditor')).default;
      if (cancelled || !ref.current) return;
      Vditor.preview(ref.current, expandWikiLinks(value ?? ''), {
        mode: 'dark',
        theme: { current: 'dark' },
        math: { engine: 'KaTeX' },
        anchor: 1,
      });
    })();
    return () => { cancelled = true; };
  }, [value]);
  return (
    <div
      ref={ref}
      className={`vditor-reset ${className ?? ''}`}
      style={{ background: 'var(--bg-1, #0b0d10)', color: 'var(--text-1, #e6e6e6)', ...style }}
    />
  );
}

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
        cache: { enable: false },
        undoDelay: 0,
        minHeight,
        placeholder,
        toolbar,
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
         * override Vditor's inline height with !important and set the content
         * pane to flex-grow with overflow:auto. */
        .pc-md-editor-host.vditor { display: flex !important; flex-direction: column !important; height: 100% !important; min-height: 0; }
        .pc-md-editor-host.vditor > .vditor-toolbar { flex: 0 0 auto; }
        .pc-md-editor-host.vditor > .vditor-content { flex: 1 1 0 !important; min-height: 0 !important; overflow: auto !important; }
        .pc-md-editor-host.vditor > .vditor-content > .vditor-ir,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-wysiwyg,
        .pc-md-editor-host.vditor > .vditor-content > .vditor-sv { min-height: 100%; }
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
