#!/usr/bin/env node
/**
 * GATING guard: the operator host bundle must actually BUILD.
 *
 * WHY (P-009, 2026-07-12): `bin/hono-host.ts` is esbuild-bundled to
 * `dist-host/hono-host.mjs` by apps/operator/bin/bundle-host.sh — which runs as the
 * service's ExecStartPre and during the release deploy, NOT during tests. So a change
 * that breaks the bundle is INVISIBLE to `npm run test:affected`, to tsc, and to the
 * green gate, and only detonates at the next restart — taking :3170 down for the whole
 * fleet and killing the deploy.
 *
 * The trigger that day: voice-node/kokoro-local dynamic-imports @huggingface/transformers,
 * which require()s onnxruntime-node's platform addon via a TEMPLATE specifier
 * (`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`).
 * esbuild followed it into all five platform binaries and hard-failed with
 * "No loader is configured for .node files". Unit tests were green throughout — they
 * import the module under tsx, which resolves natives natively.
 *
 * This is the same incident CLASS the sibling lints (no-self-referential-export,
 * smart-quotes, conflict-markers) each approximate with a pattern match: "something
 * broke bundle-host.sh, and we only found out at restart". Rather than add a fourth
 * proxy, this guard is the DIRECT detector — it runs the real bundle.
 *
 * Deliberately invokes bundle-host.sh itself (never a reimplementation) so the
 * externals/native list has ONE source of truth and cannot drift from what actually
 * ships. Output goes to a throwaway dir; the live dist-host/ is never touched.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const operatorDir = join(repoRoot, 'apps', 'operator');
const outDir = mkdtempSync(join(tmpdir(), 'papercusp-host-bundle-check-'));
const outFile = join(outDir, 'hono-host.mjs');

let failed = false;
try {
  execFileSync('bash', [join(operatorDir, 'bin', 'bundle-host.sh'), 'bin/hono-host.ts', outFile], {
    cwd: operatorDir,
    stdio: 'pipe',
    encoding: 'utf8',
    env: process.env,
  });
  console.log('✓ host bundle builds (bin/hono-host.ts → esbuild)');

  const runnerSource = join(repoRoot, 'packages', 'operator-core', 'lib', 'systemd-scope-env-runner.mjs');
  const runnerOutput = join(outDir, 'systemd-scope-env-runner.mjs');
  if (!existsSync(runnerOutput)) {
    throw new Error(`systemd scope environment runner was not published at ${runnerOutput}`);
  }
  if (readFileSync(runnerOutput, 'utf8') !== readFileSync(runnerSource, 'utf8')) {
    throw new Error('published systemd scope environment runner differs from its source');
  }
  console.log('✓ systemd scope environment runner is published beside the host bundle');
} catch (err) {
  failed = true;
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  const detail = out || (err instanceof Error ? err.message : String(err));
  const errorLines = out.split('\n').filter((l) => /✘|\[ERROR\]|No loader is configured/.test(l));
  console.error('✘ HOST BUNDLE FAILED TO BUILD — this WILL take :3170 down at the next restart');
  console.error('  and break the release deploy. It is invisible to unit tests by construction.\n');
  console.error(errorLines.length ? errorLines.slice(0, 20).join('\n') : detail.slice(-4000));
  console.error(
    '\nMost common cause: a new import pulled a package with a NATIVE (.node) addon into the\n' +
      'host graph. Fix by adding that package to NATIVE_PKGS in apps/operator/bin/bundle-host.sh\n' +
      '(and papercusp-desktop/bin/build-desktop-sidecar.sh, which ships the packaged app) so it\n' +
      'stays external and resolves from node_modules at runtime.',
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
