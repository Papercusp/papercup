import Link from 'next/link';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessRegistry } from '@/lib/harness-registry';

const SEARCH_DIRS = ['.harness', '', '.claude/skills'] as const;

function listMarkdownFiles(projectPath: string): string[] {
  const out: string[] = [];
  for (const dir of SEARCH_DIRS) {
    const full = dir ? join(projectPath, dir) : projectPath;
    if (!existsSync(full)) continue;
    try {
      for (const entry of readdirSync(full, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          out.push(entry.name.replace(/\.md$/, ''));
        }
      }
    } catch { /* permission or transient */ }
  }
  return out;
}

function similarity(a: string, b: string): number {
  const A = a.toLowerCase();
  const B = b.toLowerCase();
  if (A === B) return 1;
  if (A.includes(B) || B.includes(A)) return 0.8;
  // Quick prefix score
  let i = 0;
  while (i < Math.min(A.length, B.length) && A[i] === B[i]) i++;
  return i / Math.max(A.length, B.length);
}

export default async function WikiMissingPage({
  searchParams,
}: {
  searchParams: Promise<{ target?: string; harness?: string }>;
}) {
  const { target = '', harness = null } = await searchParams;
  const reg = loadHarnessRegistry();
  const projects = reg.projects ?? [];

  const candidates: Array<{ slug: string; filename: string; score: number }> = [];
  for (const p of projects) {
    for (const filename of listMarkdownFiles(p.path)) {
      const score = similarity(filename, target);
      if (score >= 0.4) candidates.push({ slug: p.slug, filename, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 12);

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: 24, color: '#e6e6e6', fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Wiki link not found</h1>
      <p style={{ color: '#aaa', marginBottom: 16 }}>
        No file matched <code style={{ background: '#1a1d22', padding: '2px 6px', borderRadius: 3 }}>[[{target}]]</code>
        {harness ? <> in harness <strong>{harness}</strong></> : null}.
      </p>

      {top.length > 0 ? (
        <>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Did you mean
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {top.map((c) => (
              <li key={`${c.slug}/${c.filename}`} style={{ padding: '6px 0', borderBottom: '1px solid #2a2a2a' }}>
                <Link
                  href={`/wiki?target=${encodeURIComponent(c.filename)}&harness=${encodeURIComponent(c.slug)}`}
                  style={{ color: '#6ab0ff', textDecoration: 'none' }}
                >
                  {c.slug}/{c.filename}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p style={{ color: '#aaa' }}>No similar markdown files were found across {projects.length} registered project(s).</p>
      )}

      <div style={{ marginTop: 32 }}>
        <Link href="/harness" style={{ color: '#6ab0ff' }}>← Back to harness dashboard</Link>
      </div>
    </div>
  );
}
