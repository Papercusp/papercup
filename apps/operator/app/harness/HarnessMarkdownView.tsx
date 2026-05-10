'use client';

import { useEffect, useRef } from 'react';

let vditorCssPromise: Promise<unknown> | null = null;

function loadVditorCss(): Promise<unknown> {
  if (!vditorCssPromise) vditorCssPromise = import('vditor/dist/index.css');
  return vditorCssPromise;
}

function expandWikiLinks(md: string): string {
  return (md ?? '').replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, raw, label) => {
    const target = String(raw ?? '').trim();
    const display = String(label ?? target).trim();
    const params = new URLSearchParams({ target });
    return `[${display}](/wiki?${params.toString()})`;
  });
}

export function HarnessMarkdownView({
  value,
  className,
  style,
  emptyLabel = 'No markdown content.',
}: {
  value: string | null | undefined;
  className?: string;
  style?: React.CSSProperties;
  emptyLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const markdown = (value ?? '').trim() ? (value ?? '') : `_${emptyLabel}_`;

  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;

    (async () => {
      await loadVditorCss();
      const Vditor = (await import('vditor')).default;
      if (cancelled || !ref.current) return;
      await Vditor.preview(ref.current, expandWikiLinks(markdown), {
        mode: 'dark',
        theme: { current: 'dark' },
        math: { engine: 'KaTeX' },
        anchor: 1,
        lang: 'en_US',
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [markdown]);

  return (
    <div
      ref={ref}
      className={`vditor-reset h-markdown-view ${className ?? ''}`}
      style={style}
    />
  );
}
