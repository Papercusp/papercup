'use client';

import { useEffect, useRef } from 'react';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

interface Props {
  markdown: string;
}

// `enableFeatures: false` keeps the transformer from emitting CDN-hosted
// asset URLs (KaTeX, Mermaid, etc.) in `features`. Desktop builds run
// offline; pulling scripts from cdn.jsdelivr at render time would either
// fail outright or leak metadata. Basic mind-map rendering uses only the
// directly-imported Markmap class from `markmap-view`, no loadJS needed.
const transformer = new Transformer();

export function MapView({ markdown }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<Markmap | null>(null);

  useEffect(() => {
    if (!svgRef.current) return;

    const { root } = transformer.transform(markdown || '# (empty)');

    if (!mmRef.current) {
      mmRef.current = Markmap.create(svgRef.current, {
        color: (node: any) => {
          const colors = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#bb9af7', '#7dcfff'];
          return colors[Math.abs(node.depth ?? 0) % colors.length];
        },
        duration: 300,
        maxWidth: 260,
      }, root);
    } else {
      mmRef.current.setData(root);
      mmRef.current.fit();
    }
  }, [markdown]);

  useEffect(() => () => {
    mmRef.current?.destroy();
    mmRef.current = null;
  }, []);

  if (!markdown.trim()) {
    return (
      <div className="h-empty">
        <span>write in the editor to see the mindmap</span>
      </div>
    );
  }

  return (
    <div className="h-brainstorm-map">
      <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
