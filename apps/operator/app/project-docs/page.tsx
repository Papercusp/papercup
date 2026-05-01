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
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, relative, resolve as resolvePath, sep } from 'node:path';
import { Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import { papercuspRoot } from '@/lib/papercusp-root';

export const dynamic = 'force-dynamic';

interface ProjectEntry { slug: string; path: string }
interface RegistryShape { projects: ProjectEntry[] }

function loadRegistry(): RegistryShape {
  const candidates = [
    join(papercuspRoot(), 'registry.json'),
    join(homedir(), '.restart-harness-projects.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, 'utf8')) as RegistryShape; } catch { /* ignore */ }
    }
  }
  return { projects: [] };
}

function resolveProjectPath(slug: string): string | null {
  return loadRegistry().projects.find((p) => p.slug === slug)?.path ?? null;
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
    <div style={layout}>
      <aside style={sidebar}>
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
      <main style={article}>
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
  gridTemplateColumns: '260px 1fr',
  height: '100vh',
  background: 'var(--bg-1, #1a1a1a)',
  color: 'var(--fg, #ddd)',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};
const sidebar: React.CSSProperties = {
  borderRight: '1px solid var(--border, #2a2a2a)',
  overflowY: 'auto',
  padding: '12px 0',
  background: 'var(--bg-2, #141414)',
};
const projectHeader: React.CSSProperties = { padding: '0 16px 12px', borderBottom: '1px solid var(--border, #2a2a2a)', marginBottom: 8 };
const dirHeader: React.CSSProperties = {
  padding: '4px 16px', fontSize: 11, textTransform: 'uppercase',
  letterSpacing: '.06em', color: 'var(--fg-mute, #999)',
};
const list: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const listItem: React.CSSProperties = { margin: 0 };
const linkBaseStyle: React.CSSProperties = {
  display: 'block', padding: '4px 16px', fontSize: 13, textDecoration: 'none',
};
const linkIdle: React.CSSProperties = { ...linkBaseStyle, color: 'var(--fg, #ddd)' };
const linkActive: React.CSSProperties = { ...linkBaseStyle, color: 'var(--accent, #58a6ff)', background: 'var(--bg-1, #1a1a1a)' };
const article: React.CSSProperties = {
  overflowY: 'auto', padding: '24px 32px', maxWidth: 880, margin: '0 auto',
  width: '100%', boxSizing: 'border-box',
};
const breadcrumb: React.CSSProperties = {
  fontSize: 11, color: 'var(--fg-mute, #999)', marginBottom: 16,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export default function Page(props: { searchParams: Promise<{ harness?: string; path?: string }> }) {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#888' }}>Loading project docs…</div>}>
      <ProjectDocs searchParams={props.searchParams} />
    </Suspense>
  );
}
