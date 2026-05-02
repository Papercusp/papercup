/**
 * Per-harness-project docs viewer.
 *
 * Renders markdown files from `<projectPath>/docs/` for the harness named
 * in the `?harness=<slug>` query string. Sidebar lists every .md file under
 * `docs/` so authors can navigate between features, guides, etc. The active
 * file is selected via `?path=<rel>`; default loads `index.md` (or the
 * shallowest readable file).
 *
 * This is the iframe target for the @papercupai/fumadocs plugin's per-
 * harness Docs tab. It is intentionally separate from the operator's own
 * /docs route (which serves the Papercusp specification — operator-owned
 * content, not harness-owned).
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, normalize, relative, resolve as resolvePath, sep } from 'node:path';
import { Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import { loadHarnessRegistry } from '@/lib/harness-registry';

export const dynamic = 'force-dynamic';

function resolveProjectPath(slug: string): string | null {
  return loadHarnessRegistry().projects.find((p) => p.slug === slug)?.path ?? null;
}

async function listDocs(docsRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) {
        out.push(relative(docsRoot, full));
      }
    }
  }
  await walk(docsRoot);
  return out.sort();
}

function safeJoinUnderRoot(root: string, rel: string): string | null {
  const resolved = resolvePath(root, rel);
  const safeRoot = resolvePath(root) + sep;
  if (resolved !== resolvePath(root) && !resolved.startsWith(safeRoot)) return null;
  return resolved;
}

function chooseDefaultPath(files: string[]): string | null {
  if (files.length === 0) return null;
  const preferred = files.find((f) => /^index\.(md|mdx)$/i.test(f))
    ?? files.find((f) => /^README\.(md|mdx)$/i.test(f));
  return preferred ?? files[0];
}

async function ProjectDocs({
  searchParams,
}: {
  searchParams: Promise<{ harness?: string; path?: string }>;
}) {
  const sp = await searchParams;
  const slug = sp.harness?.trim() ?? '';
  if (!slug) {
    return <Empty title="Missing ?harness=<slug>" body="Open this view via the harness Docs tab — it provides the slug." />;
  }
  const projectPath = resolveProjectPath(slug);
  if (!projectPath) return <Empty title={`Unknown harness "${slug}"`} body="No matching entry in the projects registry." />;

  const docsRoot = join(projectPath, 'docs');
  if (!existsSync(docsRoot)) {
    return (
      <Empty
        title="No docs/ directory"
        body={`This harness has no project-level documentation yet. Add markdown files under ${normalize(docsRoot)} to populate this tab.`}
      />
    );
  }

  const files = await listDocs(docsRoot);
  if (files.length === 0) {
    return <Empty title="docs/ is empty" body="Drop a markdown file under the project's docs directory and it'll show up here." />;
  }

  const requestedPath = sp.path?.trim();
  const activeRel = (requestedPath && files.includes(requestedPath))
    ? requestedPath
    : chooseDefaultPath(files);

  const activeAbs = activeRel ? safeJoinUnderRoot(docsRoot, activeRel) : null;
  const content = activeAbs && existsSync(activeAbs)
    ? await fs.readFile(activeAbs, 'utf8')
    : '*No file selected.*';

  const linkBase = `/project-docs?harness=${encodeURIComponent(slug)}&path=`;
  const grouped = groupByDir(files);

  return (
    <div style={layout} className="project-docs-shell">
      <style>{projectDocsCss}</style>
      <aside style={sidebar} className="project-docs-sidebar">
        <div style={projectHeader}>
          <strong>{slug}</strong>
          <div style={{ color: 'var(--fg-mute, #999)', fontSize: 11 }}>{normalize(projectPath)}</div>
        </div>
        {grouped.map((g) => (
          <section key={g.dir} style={{ marginBottom: 12 }}>
            <div style={dirHeader}>{g.dir || '/'}</div>
            <ul style={list}>
              {g.files.map((f) => {
                const isActive = f === activeRel;
                return (
                  <li key={f} style={listItem}>
                    <Link
                      href={`${linkBase}${encodeURIComponent(f)}`}
                      className={isActive ? 'project-docs-nav-link active' : 'project-docs-nav-link'}
                      style={isActive ? linkActive : linkIdle}
                    >
                      {basenameNoExt(f)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </aside>
      <main style={article} className="project-docs-article">
        <div style={breadcrumb}>{activeRel}</div>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </main>
    </div>
  );
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
    .map(([dir, files]) => ({ dir, files: files.sort() }));
}

function basenameNoExt(p: string): string {
  const last = p.split('/').pop() ?? p;
  return last.replace(/\.(md|mdx)$/i, '');
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ padding: '32px 24px', maxWidth: 640, margin: '0 auto', color: 'var(--fg-mute, #999)' }}>
      <h2 style={{ margin: '0 0 8px', color: 'var(--fg, #ddd)' }}>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

const layout: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(230px, 280px) minmax(0, 1fr)',
  height: '100vh',
  background: 'linear-gradient(180deg, rgba(8, 19, 34, 0.98), var(--bg-1, #0b1220))',
  color: 'var(--fg, #ddd)',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};
const sidebar: React.CSSProperties = {
  borderRight: '1px solid var(--border, #2a2a2a)',
  overflowY: 'auto',
  padding: '14px 0',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.025))',
};
const projectHeader: React.CSSProperties = {
  padding: '0 16px 14px',
  borderBottom: '1px solid var(--border, #2a2a2a)',
  marginBottom: 10,
};
const dirHeader: React.CSSProperties = {
  padding: '8px 16px 5px', fontSize: 10.5, textTransform: 'uppercase',
  letterSpacing: '.07em', color: 'var(--fg-mute, #999)',
};
const list: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const listItem: React.CSSProperties = { margin: 0 };
const linkBaseStyle: React.CSSProperties = {
  display: 'block',
  padding: '6px 16px',
  fontSize: 13,
  lineHeight: 1.25,
  textDecoration: 'none',
  borderLeft: '2px solid transparent',
};
const linkIdle: React.CSSProperties = { ...linkBaseStyle, color: 'var(--fg-dim, #b9d4e8)' };
const linkActive: React.CSSProperties = {
  ...linkBaseStyle,
  color: 'var(--accent-strong, #7dd3fc)',
  background: 'rgba(56, 189, 248, 0.10)',
  borderLeftColor: 'var(--accent, #38bdf8)',
};
const article: React.CSSProperties = {
  overflowY: 'auto',
  padding: '28px clamp(28px, 5vw, 56px) 48px',
  maxWidth: 960,
  margin: '0 auto',
  width: '100%',
  boxSizing: 'border-box',
};
const breadcrumb: React.CSSProperties = {
  fontSize: 11, color: 'var(--fg-mute, #999)', marginBottom: 18,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};
const projectDocsCss = `
  .project-docs-sidebar { scrollbar-color: rgba(125, 211, 252, 0.30) transparent; }
  .project-docs-nav-link { transition: background 140ms ease, color 140ms ease, border-color 140ms ease; }
  .project-docs-nav-link:hover,
  .project-docs-nav-link:focus-visible {
    color: var(--accent-cool, #d7f3ff) !important;
    background: rgba(125, 211, 252, 0.08);
    outline: none;
  }
  .project-docs-nav-link:focus-visible { box-shadow: inset 3px 0 0 var(--accent, #38bdf8); }
  .project-docs-article { scrollbar-color: rgba(125, 211, 252, 0.30) transparent; }
  .project-docs-article :where(h1, h2, h3) {
    color: var(--fg, #e7f7ff);
    letter-spacing: -0.035em;
    line-height: 1.08;
    text-wrap: balance;
  }
  .project-docs-article h1 {
    margin: 0 0 16px;
    font-size: clamp(2.15rem, 4.2vw, 3.05rem);
    max-width: 24ch;
  }
  .project-docs-article h2 { margin: 28px 0 12px; font-size: clamp(1.55rem, 2.6vw, 2.2rem); }
  .project-docs-article h3 { margin: 22px 0 10px; font-size: 1.25rem; }
  .project-docs-article p {
    max-width: 76ch;
    color: var(--fg-dim, #b9d4e8);
    line-height: 1.7;
  }
  .project-docs-article hr {
    margin: 10px 0 16px;
    border: 0;
    border-top: 1px solid var(--border-strong, rgba(125, 211, 252, 0.32));
  }
  .project-docs-article table {
    width: 100%;
    margin: 16px 0 28px;
    border-collapse: collapse;
    border: 1px solid var(--border, rgba(125, 211, 252, 0.15));
    border-radius: 10px;
    overflow: hidden;
    background: rgba(255,255,255,0.025);
    font-size: 13px;
  }
  .project-docs-article th,
  .project-docs-article td {
    padding: 7px 12px;
    border-bottom: 1px solid rgba(125, 211, 252, 0.10);
    vertical-align: top;
  }
  .project-docs-article th {
    color: var(--fg, #e7f7ff);
    font-size: 11px;
    letter-spacing: .04em;
    background: rgba(125, 211, 252, 0.075);
  }
  .project-docs-article tbody tr:hover { background: rgba(125, 211, 252, 0.045); }
  .project-docs-article a { color: var(--accent-strong, #7dd3fc); }
  .project-docs-article a:hover,
  .project-docs-article a:focus-visible { color: var(--accent-cool, #d7f3ff); text-decoration: underline; outline: none; }
  .project-docs-article :not(pre) > code {
    padding: 0.08rem 0.28rem;
    border: 1px solid rgba(125, 211, 252, 0.14);
    border-radius: 5px;
    background: rgba(125, 211, 252, 0.08);
    color: #d9f3ff;
  }
  @media (max-width: 760px) {
    .project-docs-shell { grid-template-columns: 1fr !important; }
    .project-docs-sidebar { max-height: 34vh; border-right: 0; border-bottom: 1px solid var(--border, #2a2a2a); }
    .project-docs-article { padding: 24px 20px 40px !important; }
  }
`;

export default function Page(props: { searchParams: Promise<{ harness?: string; path?: string }> }) {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#888' }}>Loading project docs…</div>}>
      <ProjectDocs searchParams={props.searchParams} />
    </Suspense>
  );
}
