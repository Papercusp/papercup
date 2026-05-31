'use client';

// adv:docs — renders a harness's project `docs/` markdown INLINE (#7). The
// legacy iframe to `/project-docs` broke after the operator-vite migration (that
// Next.js page no longer has a server, so the SPA fallback served the operator
// shell into the iframe). We now fetch the docs via /api/harness/:slug/project-
// docs and render them with the shared MarkdownPreview — universal across every
// harness, with a clean empty state when a harness has no docs/ dir.

import { useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { MarkdownPreview } from '@/app/_components/MarkdownEditor';

interface DocsResponse {
  ok: boolean;
  reason?: 'unknown_harness' | 'no_docs_dir' | 'empty';
  projectPath?: string;
  files: string[];
  activePath: string | null;
  content: string | null;
}

function basenameNoExt(p: string): string {
  return (p.split('/').pop() ?? p).replace(/\.(md|mdx)$/i, '');
}

function groupByDir(files: string[]): Array<{ dir: string; files: string[] }> {
  const m = new Map<string, string[]>();
  for (const f of files) {
    const slash = f.lastIndexOf('/');
    const dir = slash < 0 ? '' : f.slice(0, slash);
    const arr = m.get(dir) ?? [];
    arr.push(f);
    m.set(dir, arr);
  }
  return Array.from(m.entries())
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([dir, fs]) => ({ dir, files: fs.sort() }));
}

export default function AdvDocsTab({ slug }: { slug: string }) {
  // ?docpath= is the selected doc file — URL-backed (nuqs) so it deep-links and
  // is agent-driveable, per the repo's nuqs rule.
  const [docPath, setDocPath] = useQueryState('docpath', parseAsString);
  const [data, setData] = useState<DocsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setData({ ok: true, files: [], activePath: null, content: null });
      return;
    }
    let cancel = false;
    setData(null);
    setError(null);
    const q = docPath ? `?path=${encodeURIComponent(docPath)}` : '';
    fetch(`/api/harness/${encodeURIComponent(slug)}/project-docs${q}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: DocsResponse) => {
        if (!cancel) setData(j);
      })
      .catch((e: unknown) => {
        if (!cancel) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancel = true;
    };
  }, [slug, docPath]);

  const grouped = useMemo(() => groupByDir(data?.files ?? []), [data?.files]);

  if (error) return <div className="pc-adv-harness-panel__empty">Could not load docs: {error}</div>;
  if (!data) return <div className="pc-adv-harness-panel__empty">Loading docs…</div>;
  if (data.reason === 'unknown_harness') {
    return <div className="pc-adv-harness-panel__empty">Unknown harness “{slug}”.</div>;
  }
  if (!data.files.length) {
    return (
      <div className="pc-adv-harness-panel__empty">
        No project docs yet. Add markdown under <code>docs/</code> in this harness’s repo to populate this tab.
      </div>
    );
  }

  const activeRel = data.activePath;

  return (
    <div className="pc-adv-docs">
      <aside className="pc-adv-docs__nav">
        {grouped.map((g) => (
          <section key={g.dir} className="pc-adv-docs__navgroup">
            <div className="pc-adv-docs__navdir">{g.dir || '/'}</div>
            <ul>
              {g.files.map((f) => (
                <li key={f}>
                  <button
                    type="button"
                    className={`pc-adv-docs__navlink${f === activeRel ? ' is-active' : ''}`}
                    aria-current={f === activeRel ? 'page' : undefined}
                    onClick={() => void setDocPath(f)}
                  >
                    {basenameNoExt(f)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>
      <main className="pc-adv-docs__article">
        {activeRel && <div className="pc-adv-docs__crumb">{activeRel}</div>}
        <MarkdownPreview value={data.content ?? '*No file selected.*'} outline="left" />
      </main>

      <style>{`
        .pc-adv-docs {
          flex: 1; min-height: 0; height: 100%;
          display: grid; grid-template-columns: minmax(200px, 240px) minmax(0, 1fr);
        }
        .pc-adv-docs__nav {
          overflow-y: auto; padding: 12px 0;
          border-right: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          background: color-mix(in srgb, var(--bg-2, #0b1220), transparent 30%);
        }
        .pc-adv-docs__navgroup { margin-bottom: 12px; }
        .pc-adv-docs__navgroup + .pc-adv-docs__navgroup {
          padding-top: 4px;
          border-top: 1px solid color-mix(in srgb, var(--accent-strong), transparent 93%);
        }
        .pc-adv-docs__navdir {
          padding: 6px 14px 4px; font-size: 10.5px; text-transform: uppercase;
          letter-spacing: .07em; color: var(--fg-mute, #7f9bb4);
        }
        .pc-adv-docs__nav ul { list-style: none; margin: 0; padding: 0; }
        .pc-adv-docs__navlink {
          display: block; width: 100%; text-align: left;
          padding: 6px 14px; margin: 0 8px; font-size: 13px; line-height: 1.25;
          border: 0; border-left: 2px solid transparent; border-radius: 6px;
          background: transparent; color: var(--fg-dim, #b9d4e8); cursor: pointer;
          transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
        }
        .pc-adv-docs__navlink:hover {
          color: var(--accent-cool, #d7f3ff);
          background: color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 92%);
        }
        .pc-adv-docs__navlink.is-active {
          color: var(--accent-strong, #7dd3fc); font-weight: 600;
          background: color-mix(in srgb, var(--accent, #38bdf8), transparent 90%);
          border-left-color: var(--accent, #38bdf8);
        }
        .pc-adv-docs__article {
          overflow: auto; padding: 22px clamp(18px, 2.2vw, 30px) 40px; min-width: 0;
        }
        .pc-adv-docs__crumb {
          display: inline-flex; align-items: center; width: fit-content;
          margin-bottom: 16px; padding: 2px 8px; border-radius: 999px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
          color: var(--fg-mute, #7f9bb4);
          border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 88%);
          background: color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 94.5%);
        }
        @media (max-width: 760px) {
          .pc-adv-docs { grid-template-columns: 1fr; }
          .pc-adv-docs__nav { max-height: 32vh; border-right: 0; border-bottom: 1px solid var(--border, #2a2a2a); }
        }
      `}</style>
    </div>
  );
}
