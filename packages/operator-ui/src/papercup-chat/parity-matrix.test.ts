/**
 * Guard for PARITY.md — the Papercup-chat feature matrix (plan
 * papercup-chat-one-component-one-contract-2026-09-06, P-002; trust rows per D-005).
 *
 * What it enforces:
 *   1. the matrix parses: every row has a valid disposition, source, trust cell;
 *   2. every keep / port / retire / open row's named source symbol still exists
 *      at the named path — a symbol that disappears WITHOUT the matrix changing
 *      fails here (rename it in the matrix in the same change);
 *   3. every `retired` row's symbol is GONE — a retired duplicate cannot return;
 *   4. every `ported` row's TARGET symbol exists (flip port → ported in the
 *      change that lands the move; the source is no longer asserted);
 *   5. the D-005 security invariants on the markdown rows (no raw HTML on either
 *      host, links only via allowlist, images off on the public host, the
 *      `owner` trust may widen tables/images but never HTML).
 *
 * Portal rows read the sibling checkout (`../portal` from this repo's root, or
 * `PAPERCUP_PORTAL_ROOT`). When it is absent those rows are SKIPPED — reported
 * as skipped, never silently green.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  parseParityMatrix,
  stripComments,
  symbolPresent,
  type Repo,
  type SourceRef,
} from './parity-matrix';

const here = dirname(fileURLToPath(import.meta.url));
// packages/operator-ui/src/papercup-chat → repo root is four levels up.
const PAPERCUSP_ROOT = resolve(here, '..', '..', '..', '..');
const PORTAL_ROOT = process.env.PAPERCUP_PORTAL_ROOT ?? resolve(PAPERCUSP_ROOT, '..', 'portal');
// Overridable so a mutation probe can point the guard at a COPY of the matrix
// (scripts/mutation-probe.sh tier 2) instead of mutating the shared tree.
const MATRIX_PATH = process.env.PAPERCUP_PARITY_MATRIX ?? resolve(here, 'PARITY.md');
const CANONICAL_DOC_PATH = resolve(
  PAPERCUSP_ROOT,
  'apps/operator-docs/src/content/docs/agent-insights/papercup-chat-one-component-one-contract.mdx',
);
const PUBLIC_DOC_PATH = resolve(
  PAPERCUSP_ROOT,
  'apps/operator/public/internal/docs/agent-insights/papercup-chat-one-component-one-contract.md',
);
const REPO_CONVENTIONS_DOC_PATH = resolve(
  PAPERCUSP_ROOT,
  'apps/operator-docs/src/content/docs/system/repo-conventions.mdx',
);
const REPO_CONVENTIONS_PUBLIC_DOC_PATH = resolve(
  PAPERCUSP_ROOT,
  'apps/operator/public/internal/docs/system/repo-conventions.md',
);
const SHARED_CHAT_VIEW_PATH = resolve(PAPERCUSP_ROOT, 'packages/operator-ui/src/papercup-chat/PapercupChat.tsx');
const DELETED_CHAT_RENDERER_PATH = resolve(PAPERCUSP_ROOT, 'apps/operator/app/_components/chat/ChatConversation.tsx');

const matrix = parseParityMatrix(readFileSync(MATRIX_PATH, 'utf8'));
const portalAvailable = existsSync(resolve(PORTAL_ROOT, 'packages', 'ui', 'src'));

function repoRoot(repo: Repo): string {
  return repo === 'papercusp' ? PAPERCUSP_ROOT : PORTAL_ROOT;
}

function readRef(ref: SourceRef): { file: string; exists: boolean; text: string } {
  const file = resolve(repoRoot(ref.repo), ref.path);
  const exists = existsSync(file);
  return { file, exists, text: exists ? readFileSync(file, 'utf8') : '' };
}

function describeSymbol(ref: SourceRef): string {
  return ref.symbol.kind === 'identifier' ? ref.symbol.name : `"${ref.symbol.text}"`;
}

/** Compare the substantive projected content, ignoring only Markdown's equivalent list marker. */
function projectedDocBody(text: string): string {
  const start = text.indexOf('## What is canonical');
  if (start < 0) return '';
  return text
    .slice(start)
    .replace(/^\* /gm, '- ')
    .trim();
}

describe('PARITY.md — Papercup chat feature matrix', () => {
  it('resolves the papercusp repo root (guards the path arithmetic above)', () => {
    const pkg = JSON.parse(readFileSync(resolve(PAPERCUSP_ROOT, 'package.json'), 'utf8')) as { name?: string };
    expect(pkg.name).toBe('@papercupai/papercusp-monorepo');
  });

  it('parses with no errors', () => {
    expect(matrix.errors).toEqual([]);
  });

  it('has rows on every side', () => {
    const sides = new Set(matrix.rows.map((r) => r.side));
    expect(matrix.rows.length).toBeGreaterThan(0);
    expect([...sides].sort()).toEqual(['operator', 'portal', 'shared']);
  });

  it('never gives one source symbol two different dispositions', () => {
    const byRef = new Map<string, Set<string>>();
    for (const r of matrix.rows) {
      if (!r.source) continue;
      const key = `${r.source.repo}/${r.source.path}#${describeSymbol(r.source)}`;
      const set = byRef.get(key) ?? new Set<string>();
      set.add(r.disposition.startsWith('open:') ? 'open' : r.disposition);
      byRef.set(key, set);
    }
    const conflicts = [...byRef].filter(([, set]) => set.size > 1).map(([k, set]) => `${k}: ${[...set].join(' vs ')}`);
    expect(conflicts).toEqual([]);
  });

  it('keeps the canonical Papercup-chat insight and public Markdown projection in lockstep', () => {
    const canonical = readFileSync(CANONICAL_DOC_PATH, 'utf8');
    const published = readFileSync(PUBLIC_DOC_PATH, 'utf8');
    expect(canonical).toContain('GENERATED PROJECTION — DO NOT EDIT THIS FILE BY HAND');
    expect(projectedDocBody(published)).toBe(projectedDocBody(canonical));
    for (const required of [
      'PapercupChat',
      'usePapercupChat',
      '@papercusp/chat-protocol',
      'hostTrust="public" | "owner"',
      'ChatConversation',
      'AskPapercupPanel',
      '## D-011 visual contract',
    ]) {
      expect(projectedDocBody(canonical), `canonical insight must document ${required}`).toContain(required);
    }
  });

  it('keeps repo-conventions aligned with the deleted renderer and shared PapercupChat view', () => {
    const canonical = readFileSync(REPO_CONVENTIONS_DOC_PATH, 'utf8');
    const published = readFileSync(REPO_CONVENTIONS_PUBLIC_DOC_PATH, 'utf8');
    const deletedRendererClaim = 'The former operator-local `chat/ChatConversation` renderer is deleted.';
    const sharedRendererClaim =
      'The shared `PapercupChat` view in `packages/operator-ui/src/papercup-chat/PapercupChat.tsx` is the sole transcript renderer.';

    expect(existsSync(SHARED_CHAT_VIEW_PATH)).toBe(true);
    expect(existsSync(DELETED_CHAT_RENDERER_PATH)).toBe(false);
    for (const projection of [canonical, published]) {
      expect(projection).toContain(deletedRendererClaim);
      expect(projection).toContain(sharedRendererClaim);
      expect(projection).not.toContain('Shared chat infra stays live (`OperatorConversationProvider`, `chat/ChatConversation`');
    }
  });

  describe('source symbols still exist (or are gone, for retired rows)', () => {
    for (const row of matrix.rows) {
      const ref = row.source;
      if (!ref || row.disposition === 'ported') continue; // ported rows are judged on their target below
      const skip = ref.repo === 'portal' && !portalAvailable;
      const name = `${row.id} [${row.disposition}] ${ref.repo}/${ref.path}#${describeSymbol(ref)}`;
      it.skipIf(skip)(name, () => {
        const { file, exists, text } = readRef(ref);
        if (row.disposition === 'retired') {
          const present = exists && symbolPresent(text, ref.symbol);
          expect(
            present,
            `${row.id} is marked retired but ${describeSymbol(ref)} is back in ${file} — either un-retire the row or delete the duplicate`,
          ).toBe(false);
          return;
        }
        expect(exists, `${row.id}: ${file} no longer exists — update the source cell on PARITY.md:${row.line}`).toBe(true);
        expect(
          symbolPresent(text, ref.symbol),
          `${row.id}: ${describeSymbol(ref)} is no longer in ${ref.path} — rename it on PARITY.md:${row.line} (or mark the row retired) in the same change`,
        ).toBe(true);
      });
    }
  });

  describe('ported rows — the target symbol exists', () => {
    const ported = matrix.rows.filter((r) => r.disposition === 'ported' && r.target);
    // An empty describe is a Vitest collection error ("No test found in suite"), so the
    // not-yet-any-ported state is recorded as an explicit skip rather than an empty suite.
    it.skipIf(ported.length > 0)('no ported rows yet (P-007 has not landed) — nothing to check', () => {});
    for (const row of ported) {
      const ref = row.target;
      if (!ref) continue;
      const skip = ref.repo === 'portal' && !portalAvailable;
      it.skipIf(skip)(`${row.id} → ${ref.repo}/${ref.path}#${describeSymbol(ref)}`, () => {
        const { file, exists, text } = readRef(ref);
        expect(exists, `${row.id} is marked ported but ${file} does not exist — fix the target on PARITY.md:${row.line}`).toBe(true);
        expect(
          symbolPresent(text, ref.symbol),
          `${row.id}: target ${describeSymbol(ref)} is not in ${file} — the port landed under a different name; fix PARITY.md:${row.line}`,
        ).toBe(true);
      });
    }
  });

  describe('D-005 trust dispositions on the markdown rows', () => {
    const md = matrix.rows.filter((r) => r.id.startsWith('md-'));
    const byId = new Map(md.map((r) => [r.id, r]));

    it('every markdown-feature row (md-*) carries a public/owner trust cell', () => {
      const missing = md.filter((r) => !r.trust).map((r) => r.id);
      expect(missing).toEqual([]);
    });

    it('only markdown-feature rows carry a trust cell', () => {
      const stray = matrix.rows.filter((r) => r.trust && !r.id.startsWith('md-')).map((r) => r.id);
      expect(stray).toEqual([]);
    });

    it('names the D-005 hostile features explicitly', () => {
      for (const id of ['md-html', 'md-html-comment', 'md-links', 'md-unsafe-url', 'md-images', 'md-tables', 'md-work-refs']) {
        expect(byId.has(id), `PARITY.md must carry a ${id} row (D-005)`).toBe(true);
      }
    });

    it('raw HTML and HTML comments are inert on BOTH hosts (never widened by trust)', () => {
      for (const id of ['md-html', 'md-html-comment']) {
        expect(byId.get(id)?.trust).toEqual({ public: 'inert', owner: 'inert' });
      }
    });

    it('links render only through the URL-scheme allowlist on BOTH hosts', () => {
      expect(byId.get('md-links')?.trust).toEqual({ public: 'allowlist', owner: 'allowlist' });
      expect(byId.get('md-unsafe-url')?.trust).toEqual({ public: 'inert', owner: 'inert' });
    });

    it('images are off on the public host and opt-in for the owner', () => {
      expect(byId.get('md-images')?.trust).toEqual({ public: 'off', owner: 'opt-in' });
    });

    it('tables may be widened by owner trust but never render for the public host', () => {
      const t = byId.get('md-tables')?.trust;
      expect(t?.public).not.toBe('render');
      expect(t?.owner).toBe('render');
    });

    it('work-ref pills render only for refs the host can resolve', () => {
      const t = byId.get('md-work-refs')?.trust;
      expect(t?.public).toBe('inert');
      expect(t?.owner).toBe('render');
    });
  });
});

describe('guard falsifiability — controls that prove the assertions can fire', () => {
  const header = `| ${COLUMNS.join(' | ')} |\n|${COLUMNS.map(() => '---').join('|')}|\n`;

  it('a row without a disposition is a parse error', () => {
    const { errors, rows } = parseParityMatrix(
      header + '| x-one | operator | thing | `papercusp/a.ts#A` |  | — | — | because |\n',
    );
    expect(rows).toHaveLength(0);
    expect(errors.some((e) => e.includes('disposition'))).toBe(true);
  });

  it('a port or ported row without a target is a parse error', () => {
    for (const d of ['port', 'ported']) {
      const { errors } = parseParityMatrix(header + `| x-one | operator | thing | \`papercusp/a.ts#A\` | ${d} | — | — | because |\n`);
      expect(errors.some((e) => e.includes('must name its target')), d).toBe(true);
    }
  });

  it('a malformed trust cell is a parse error', () => {
    const { errors } = parseParityMatrix(header + '| md-x | shared | thing | `papercusp/a.ts#A` | keep | public=yes | — | because |\n');
    expect(errors.some((e) => e.includes('trust'))).toBe(true);
  });

  it('a well-formed row parses to the expected shape', () => {
    const { errors, rows } = parseParityMatrix(
      header + '| md-x | shared | bold | `portal/p/ui.tsx#formatAskText` | port | public=render owner=render | `papercusp/x.tsx#PapercupChat` | why |\n',
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'md-x',
      side: 'shared',
      disposition: 'port',
      trust: { public: 'render', owner: 'render' },
      source: { repo: 'portal', path: 'p/ui.tsx', symbol: { kind: 'identifier', name: 'formatAskText' } },
      target: { repo: 'papercusp', path: 'x.tsx', symbol: { kind: 'identifier', name: 'PapercupChat' } },
    });
  });

  it('symbolPresent: declaration / import / JSX / call all count', () => {
    expect(symbolPresent('export function Foo() {}', { kind: 'identifier', name: 'Foo' })).toBe(true);
    expect(symbolPresent("import { Foo } from './foo';", { kind: 'identifier', name: 'Foo' })).toBe(true);
    expect(symbolPresent('return <Foo a={1} />;', { kind: 'identifier', name: 'Foo' })).toBe(true);
    expect(symbolPresent('const x = Foo(1);', { kind: 'identifier', name: 'Foo' })).toBe(true);
  });

  it('symbolPresent: a symbol that survives only in a comment reads as ABSENT (the deleted-but-mentioned case)', () => {
    const text = '// Foo used to live here\n/* <Foo/> */\nexport function Bar() {}';
    expect(symbolPresent(text, { kind: 'identifier', name: 'Foo' })).toBe(false);
    expect(stripComments(text)).not.toContain('Foo');
  });

  it('symbolPresent: a longer identifier does not satisfy a shorter one', () => {
    expect(symbolPresent('export function FooBar() {}', { kind: 'identifier', name: 'Foo' })).toBe(false);
    expect(symbolPresent('const x = myFoo(1);', { kind: 'identifier', name: 'Foo' })).toBe(false);
  });

  it('symbolPresent: literals match verbatim, comments included', () => {
    expect(symbolPresent('fetch("/api/agent-mcp/operator-converse")', { kind: 'literal', text: '/api/agent-mcp/operator-converse' })).toBe(true);
    expect(symbolPresent('fetch("/api/other")', { kind: 'literal', text: '/api/agent-mcp/operator-converse' })).toBe(false);
  });

  it('the real predicate fires on the REAL matrix when one row’s symbol is renamed (in-memory mutant, tree untouched)', () => {
    const victim = matrix.rows.find(
      (r) => r.source?.repo === 'papercusp' && r.source.symbol.kind === 'identifier' && r.disposition !== 'retired',
    );
    expect(victim?.source).toBeDefined();
    const lines = readFileSync(MATRIX_PATH, 'utf8').split(/\r?\n/);
    const original = lines[victim!.line - 1];
    const mutatedLine = original.replace(`#${(victim!.source!.symbol as { name: string }).name}\``, '#DefinitelyNotASymbol__`');
    expect(mutatedLine).not.toBe(original); // the mutation must actually change something
    lines[victim!.line - 1] = mutatedLine;
    const mutant = parseParityMatrix(lines.join('\n'));
    expect(mutant.errors).toEqual([]);
    const row = mutant.rows.find((r) => r.id === victim!.id)!;
    const { exists, text } = readRef(row.source!);
    expect(exists).toBe(true);
    expect(symbolPresent(text, row.source!.symbol)).toBe(false); // ⇒ the source-symbol guard above would fail for this row
  });

  it('a retired row whose symbol is still declared would FAIL the guard (negative control)', () => {
    // Same predicate the retired branch above evaluates, on a fixture where the symbol is present.
    const present = symbolPresent('export function AskPapercupPanel() {}', { kind: 'identifier', name: 'AskPapercupPanel' });
    expect(present).toBe(true); // ⇒ the guard's `expect(present).toBe(false)` fires
  });

  it('the documentation-projection guard detects a drifted public projection', () => {
    const canonical = projectedDocBody(readFileSync(CANONICAL_DOC_PATH, 'utf8'));
    const published = projectedDocBody(readFileSync(PUBLIC_DOC_PATH, 'utf8'));
    const mutant = published.replace('PapercupChat', 'DivergedPapercupChat');
    expect(mutant).not.toBe(published);
    expect(mutant).not.toBe(canonical);
  });
});
