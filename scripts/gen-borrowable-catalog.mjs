#!/usr/bin/env node
/**
 * gen-borrowable-catalog.mjs — regenerate BORROWABLE.md.
 *
 * Papercusp owns a set of general-purpose libraries that carry **no
 * Papercusp/Restart domain coupling** — any project can borrow them. They
 * live scattered across `packages/*` (in-repo) and `libs/*` (git
 * submodules = standalone repos under github.com/Papercusp/). This script
 * is the single source of truth for *which* libs are borrowable; it reads
 * each one's package.json for name + description and its repo from
 * .gitmodules, then emits a grouped catalog.
 *
 *   node scripts/gen-borrowable-catalog.mjs        # write BORROWABLE.md
 *   node scripts/gen-borrowable-catalog.mjs --check # CI: fail if stale
 *
 * To add/remove a lib, edit BORROWABLE below and re-run. Membership is
 * curated here (not a package.json keyword) so tagging a submodule never
 * requires a submodule commit. See papercusp-systems-abstraction-2026-05-29.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The borrowable set — genuinely generic, zero retained domain tie-in. */
const BORROWABLE = [
  // path (repo-relative)                  category                fallback description (only if package.json lacks one)
  ['libs/generic/rrf',                        'Pure utilities & infra'],
  ['libs/generic/rules',                      'Pure utilities & infra'],
  ['libs/generic/step-program',               'Pure utilities & infra'],
  ['libs/generic/event-reaction',             'Pure utilities & infra'],
  ['libs/generic/structured-concurrency',     'Pure utilities & infra'],
  ['libs/generic/failure-detector',           'Pure utilities & infra'],
  ['libs/generic/locks-core',                 'Pure utilities & infra'],
  ['libs/generic/fanout-resolver',            'Pure utilities & infra'],
  ['libs/generic/projection-index',           'Pure utilities & infra'],
  ['libs/generic/activity-bridge',            'Pure utilities & infra'],
  ['libs/generic/plugin-loader',              'Pure utilities & infra'],
  ['libs/generic/control-mutation',           'Pure utilities & infra'],
  ['libs/generic/embedded-pg-discovery',      'Pure utilities & infra'],
  ['libs/generic/linkable-edges',             'Pure utilities & infra'],
  ['libs/generic/plan-parser',                'Pure utilities & infra'],
  ['libs/generic/rate-limit',                 'Pure utilities & infra'],
  ['libs/generic/artifact-registry',          'Pure utilities & infra'],
  ['libs/generic/papergrid/kv-persist',           'Pure utilities & infra'],
  ['libs/generic/papergrid/kv-persist-indexeddb', 'Pure utilities & infra'],
  ['libs/papercusp/packages/file-claim',  'Pure utilities & infra'],
  ['libs/generic/token-kit',                      'Pure utilities & infra'],
  ['libs/generic/search',                     'Search & retrieval'],
  ['libs/generic/search-core',                    'Search & retrieval'],
  ['libs/generic/rerank',                         'Search & retrieval'],
  ['libs/generic/memory',                     'Search & retrieval'],
  ['libs/generic/ipc-framing',                'IPC, transport & sync'],
  ['libs/generic/ipc-endpoint-server',        'IPC, transport & sync'],
  ['libs/generic/desktop-ipc',                'IPC, transport & sync'],
  ['libs/generic/sse',                            'IPC, transport & sync'],
  ['libs/generic/sync',                           'IPC, transport & sync'],
  ['libs/generic/chat-protocol',                  'IPC, transport & sync'],
  ['libs/generic/tooldef',                        'IPC, transport & sync'],
  ['libs/generic/tooldef-http',                   'IPC, transport & sync'],
  ['libs/generic/pubsub-substrate',               'IPC, transport & sync'],
  ['libs/generic/p2p-voice',                      'Audio & media'],
  ['libs/generic/audio-dsp',                      'Audio & media'],
  ['libs/generic/ui-primitives',                  'UI components'],
  ['libs/generic/dock-workbench',                 'UI components'],
  ['libs/generic/git-graph',                      'UI components'],
  ['libs/generic/papergrid/grid-core',            'UI components'],
  ['libs/generic/papergrid/bloom-grid',           'UI components'],
  ['libs/generic/tauri-release-kit',              'Build & release'],
  ['libs/testing-shell',                          'Testing & QA'],
  ['libs/test-config',                            'Testing & QA'],
];

/**
 * Reusable-but-coupled: shipped with a host-injection seam, but deliberately
 * retain a Papercusp tie-in (kept by decision). Listed for discoverability,
 * not "borrow as-is".
 */
const SEAMED = [
  ['libs/papercusp/packages/locks', 'Distributed file-lock coordinator (own side-DB + advisory locks); generic via an opaque coordination domain.'],
  ['packages/coordination',   'Papercusp Postgres tie-in adapter over @papercusp/pubsub-substrate (generic pub/sub: core + event-log + presence + watermark + topic/subscription/thread fan-out) and @papercusp/linkable-edges; keeps only the harness_shared-bound Pg* backends.'],
  ['packages/backup',         'Per-workspace kopia backup behind a BackupHost config seam.'],
  ['packages/docs-engine',    'Source-agnostic docs retrieval; ships a generic-fs/starlight adapter plus a harness-fs one.'],
  ['libs/host-platform',      'The host-boundary interface — the ~10% that is genuinely host-specific (fs, PG-DSN resolution).'],
];

const CATEGORY_ORDER = ['Pure utilities & infra', 'Search & retrieval', 'IPC, transport & sync', 'UI components', 'Build & release', 'Testing & QA'];

function parseGitmodules() {
  const map = {};
  let text = '';
  try { text = readFileSync(join(ROOT, '.gitmodules'), 'utf8'); } catch { return map; }
  let path = null;
  for (const line of text.split('\n')) {
    const p = line.match(/^\s*path\s*=\s*(.+)\s*$/);
    const u = line.match(/^\s*url\s*=\s*(.+)\s*$/);
    if (p) path = p[1].trim();
    if (u && path) { map[path] = u[1].trim(); path = null; }
  }
  return map;
}

function readPkg(p) {
  return JSON.parse(readFileSync(join(ROOT, p, 'package.json'), 'utf8'));
}

/** Find the submodule root that contains `p` (a path may live under a submodule). */
function sourceFor(p, submodules) {
  if (submodules[p]) return { kind: 'submodule', repo: submodules[p], path: p };
  for (const subPath of Object.keys(submodules)) {
    if (p === subPath || p.startsWith(subPath + '/')) {
      return { kind: 'submodule', repo: submodules[subPath], path: p, nested: p !== subPath };
    }
  }
  return { kind: 'in-repo', path: p };
}

function repoCell(src) {
  if (src.kind === 'submodule') {
    const slug = src.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    const label = src.nested ? `\`${src.path}\` · ` : '';
    return `${label}[${slug}](${src.repo})`;
  }
  return `in-repo · \`${src.path}\``;
}

function row(p, fallbackDesc, submodules) {
  const pkg = readPkg(p);
  const desc = (pkg.description || fallbackDesc || '—').replace(/\s+/g, ' ').trim();
  return `| \`${pkg.name}\` | ${desc} | ${repoCell(sourceFor(p, submodules))} |`;
}

function build() {
  const submodules = parseGitmodules();
  const byCat = {};
  for (const [p, cat, fb] of BORROWABLE) (byCat[cat] ??= []).push(row(p, fb, submodules));

  const lines = [];
  lines.push('# Borrowable libraries');
  lines.push('');
  lines.push('> **Generated — do not edit by hand.** Run `npm run gen:borrowable`.');
  lines.push('> Source of truth: `scripts/gen-borrowable-catalog.mjs`.');
  lines.push('');
  lines.push('Papercusp builds a number of **general-purpose libraries with zero');
  lines.push('Papercusp/Restart domain coupling** — any project can borrow them. Each');
  lines.push('names no consuming app: where a host-specific value is needed it is');
  lines.push('injected via a small seam (a `configure*()` call or a prop), and Papercusp');
  lines.push('maps its own domain onto that seam in the operator.');
  lines.push('');
  lines.push('Most live as standalone git submodules (their own repo under');
  lines.push('`github.com/Papercusp/`) — clone that one repo to borrow it. In-repo');
  lines.push('packages are consumed as `file:` workspace deps and can be promoted to');
  lines.push('their own repo when needed.');
  lines.push('');
  lines.push('**Generic-first.** A new domain-free algorithm — a textbook concurrency /');
  lines.push('distributed-systems / data-structure core — **starts in `libs/generic/<name>`');
  lines.push('behind a seam**, not in the app to be migrated out later. `npm run');
  lines.push('lint:generic-first` (advisory; `:all` for a full-tree sweep) flags a');
  lines.push('zero-coupling, concept-naming algorithm file that landed in the app and nudges');
  lines.push('it here.');
  lines.push('');
  for (const cat of CATEGORY_ORDER) {
    if (!byCat[cat]) continue;
    lines.push(`## ${cat}`);
    lines.push('');
    lines.push('| Package | What it is | Source |');
    lines.push('|---|---|---|');
    lines.push(...byCat[cat].sort());
    lines.push('');
  }
  lines.push('## Reusable with host wiring (Papercusp tie-in kept by design)');
  lines.push('');
  lines.push('These ship a host-injection seam but deliberately retain a Papercusp');
  lines.push('tie-in (DB/schema/path assumptions). Borrowable with adaptation, not as-is.');
  lines.push('');
  lines.push('| Package | What it is | Source |');
  lines.push('|---|---|---|');
  for (const [p, fb] of SEAMED) lines.push(row(p, fb, submodules));
  lines.push('');
  return lines.join('\n') + '\n';
}

const out = build();
const target = join(ROOT, 'BORROWABLE.md');
if (process.argv.includes('--check')) {
  let cur = '';
  try { cur = readFileSync(target, 'utf8'); } catch { /* missing */ }
  if (cur !== out) {
    console.error('BORROWABLE.md is stale — run `npm run gen:borrowable` and commit.');
    process.exit(1);
  }
  console.log('BORROWABLE.md is up to date.');
} else {
  writeFileSync(target, out);
  console.log(`Wrote ${target} (${BORROWABLE.length} borrowable + ${SEAMED.length} seam'd).`);
}
