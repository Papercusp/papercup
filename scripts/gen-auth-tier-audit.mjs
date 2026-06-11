#!/usr/bin/env node
/**
 * gen-auth-tier-audit — the D-007 (papercusp-full-app-audit-2026-06-09)
 * generator: scans every defineTool route definition and emits the per-route
 * auth-tier proposal table the owner reviews before the EI-100 mass flip.
 *
 *   node scripts/gen-auth-tier-audit.mjs        # writes the doc
 *   node scripts/gen-auth-tier-audit.mjs --check # exits 1 if doc is stale
 *
 * Output: apps/operator/docs/auth-tier-rollout-2026-06-10.md
 *
 * Classification rules (D-007):
 *   - handler already calls requireLoopbackOr403 → `loopback` (declarative
 *     conversion only — no behavior change).
 *   - mutating verb (POST/PUT/PATCH/DELETE)      → propose `loopback`,
 *     UNLESS the path matches a REMOTE_SURFACES pattern → `public!` (named
 *     exception, owner must confirm each).
 *   - everything else (GET/HEAD reads)           → stay `public` — the
 *     127.0.0.1 bind is the perimeter for reads (P-027).
 *
 * This is a static heuristic scan (regex, not a TS program graph) — good
 * enough for a review table, NOT an enforcement mechanism. Enforcement land
 * is the dispatch chokepoint per D-007 once the owner approves.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = [
  'packages/operator-core/lib/endpoint-route/routes',
  'apps/operator/lib/endpoint-route/routes',
];
const OUT = join(ROOT, 'apps/operator/docs/auth-tier-rollout-2026-06-10.md');

/** Path patterns that are legitimately remote-reachable — the Wave-1
 *  exception list. Each row matched here is flagged for explicit owner
 *  confirmation rather than auto-proposed loopback. */
const REMOTE_SURFACES = [
  { re: /^\/device(\/|$)/, why: 'device-JWT mobile surface (own auth)' },
  { re: /webhook/i, why: 'inbound webhook (provider-signed)' },
  { re: /^\/auth(\/|$)/, why: 'auth handshake must be reachable pre-auth' },
  { re: /^\/substrate(\/|$)/, why: 'federation/substrate peer surface' },
  { re: /^\/federation(\/|$)/, why: 'federation peer surface' },
  // Cross-machine peer RPC for the per-harness lock authority (Track B) —
  // HttpPeerRpcTransport posts here from REMOTE swarms; loopback would break
  // federated lease ops. Caller-standing hardening tracked as EI-284.
  { re: /^\/authority\/rpc$/, why: 'cross-swarm authority RPC (peer transport; EI-284 hardening pending)' },
  { re: /^\/cupboard\/listings/, why: 'public pack listings proxy' },
  { re: /^\/health$|^\/healthz/, why: 'health probe' },
];

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !/\.test\.ts$|\.integration\.test\.ts$/.test(p)) yield p;
  }
}

function scanFile(abs) {
  const text = readFileSync(abs, 'utf8');
  const rel = relative(ROOT, abs);
  const fileGated = text.includes('requireLoopbackOr403');
  const out = [];
  // One entry per defineTool block; tolerate multiple per file.
  const blocks = text.split(/defineTool\s*\(\s*\{/).slice(1);
  for (const block of blocks) {
    const method = block.match(/method:\s*'([A-Z]+)'/)?.[1] ?? null;
    const path = block.match(/path:\s*'([^']+)'/)?.[1] ?? null;
    // Three auth shapes: string ('public'), object ({ trust: [...] }), or
    // ABSENT — absent means default-deny / principal-required (RFC
    // tooldef-auth Phase 3), i.e. NOT public.
    const auth = block.match(/auth:\s*'([a-z-]+)'/)?.[1]
      ?? (/auth:\s*\{/.test(block) ? 'trust' : 'principal (default)');
    if (!path || !method) continue; // tool-only defs (no HTTP projection)
    out.push({ file: rel, method, path, auth, fileGated });
  }
  return out;
}

function classify(r) {
  if (r.auth === 'loopback') return { tier: 'loopback', wave: 'DONE', why: 'declared loopback tier — enforced at the route-stack chokepoint (Wave 1 landed 2026-06-11)' };
  if (r.auth !== 'public') return { tier: r.auth, wave: '-', why: 'already non-public (trust-gated or principal-required default)' };
  if (r.fileGated) return { tier: 'loopback', wave: 'W1a', why: 'hand-gated today — declarative conversion, zero behavior change' };
  const remote = REMOTE_SURFACES.find((s) => s.re.test(r.path));
  if (remote) return { tier: 'public!', wave: 'OWNER', why: remote.why };
  if (MUTATING.has(r.method)) return { tier: 'loopback', wave: 'W1', why: 'mutating verb → loopback default' };
  return { tier: 'public', wave: 'W2', why: 'read — loopback BIND is the perimeter' };
}

const rows = [];
for (const dir of SCAN_DIRS) {
  try {
    for (const f of walk(join(ROOT, dir))) rows.push(...scanFile(f));
  } catch { /* dir absent in some checkouts */ }
}
for (const r of rows) Object.assign(r, classify(r));
rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const counts = rows.reduce((m, r) => ((m[r.wave] = (m[r.wave] ?? 0) + 1), m), {});
const lines = [];
lines.push('# Auth-tier rollout table — EI-100 / audit P-032 (generated)');
lines.push('');
lines.push('> GENERATED by `node scripts/gen-auth-tier-audit.mjs` — do not hand-edit.');
lines.push('> Design + wave semantics: papercusp-full-app-audit-2026-06-09 D-007.');
lines.push('> OWNER GATE: rows in wave `OWNER` (tier `public!`) are the named remote');
lines.push('> exceptions — each needs explicit confirmation. `W1a` is the no-behavior-');
lines.push('> change declarative conversion of existing hand-called loopback gates;');
lines.push('> `W1` is the mutating→loopback default; `W2` reads stay public.');
lines.push('');
lines.push(`Total HTTP-projected routes scanned: **${rows.length}**`);
lines.push('');
lines.push('| wave | routes |');
lines.push('|---|---|');
for (const [w, n] of Object.entries(counts).sort()) lines.push(`| ${w} | ${n} |`);
lines.push('');
lines.push('| method | path | current | proposed | wave | reason | file |');
lines.push('|---|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(`| ${r.method} | \`${r.path}\` | ${r.auth ?? '—'} | ${r.tier} | ${r.wave} | ${r.why} | ${r.file} |`);
}
lines.push('');
const doc = lines.join('\n');

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(OUT, 'utf8'); } catch { /* absent */ }
  if (current !== doc) {
    console.error('auth-tier audit doc is stale — run: node scripts/gen-auth-tier-audit.mjs');
    process.exit(1);
  }
  console.log('auth-tier audit doc is fresh');
} else {
  writeFileSync(OUT, doc);
  console.log(`wrote ${relative(ROOT, OUT)} — ${rows.length} routes (${Object.entries(counts).map(([w, n]) => `${w}:${n}`).join(' ')})`);
}
