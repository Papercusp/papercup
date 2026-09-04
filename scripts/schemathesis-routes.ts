#!/usr/bin/env node
// scripts/schemathesis-routes.ts — P-024, plan design-to-code-coverage-seam-2026-09-02.
//
// Run Schemathesis over the `http-route` surfaces, generating positive,
// negative and stateful cases FROM the OpenAPI document, with zero
// per-endpoint maintenance.
//
//   npm run gate:schemathesis                       # against a running :3070
//   npm run gate:schemathesis -- --url http://127.0.0.1:3170
//   npm run gate:schemathesis -- --include-path-regex '^/api/health'
//   npm run gate:schemathesis -- --schema /tmp/openapi.json --json
//
// ── The toolchain judgement this item owed (D-049) ──
// Schemathesis is a PYTHON tool. npm cannot acquire it, so this gate adds a
// non-npm toolchain dependency, and that has to be answered out loud rather
// than by omission:
//
//   PINNED   — `SCHEMATHESIS_PIN` in the lib module is the single copy of the
//              intended version. Nothing else restates it.
//   ACQUIRED — `pipx run schemathesis==<pin>` needs no global install and no
//              virtualenv management, so CI acquires the pin by running it.
//              An already-installed module is used as-is when present.
//   ABSENT   — the gate REFUSES: exit 2, naming the remedy. It does NOT skip.
//
// That last line is the whole point. The plan's D-008 says a check that cannot
// fail is decoration; a gate that silently exits 0 when its dependency is
// missing is worse, because it reports success for work it never did. Note the
// plan's D-004 rejected a dependency in the analogous cover-agent case — that
// was an UNMAINTAINED OSS dependency reimplementable on in-repo surfaces.
// Schemathesis 4.x is actively maintained and implements property-based
// OpenAPI fuzzing with a Rust core; reimplementing it is not a day's work and
// would be a strictly worse instrument. Different situation, opposite call,
// stated deliberately rather than by silence.
//
// EXIT CODES — three-valued, matching the sibling gates:
//   0  PASS         — ran over at least one operation and found no violation
//   1  VIOLATIONS   — ran and found conclusive schema violations
//   2  UNAVAILABLE  — could not measure (toolchain absent, schema unreachable,
//                     server down, or a run that exercised nothing). NEVER
//                     collapsed into 0.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCHEMATHESIS_PIN,
  buildSchemathesisArgv,
  describeSchemathesisVerdict,
  judgeSchemathesisRun,
  parseSchemathesisReport,
  resolveSchemathesisToolchain,
  schemathesisExitCode,
  summarizeOpenApiSurface,
  type SchemathesisRunObservation,
  type SchemathesisToolchainProbe,
} from '../packages/operator-core/lib/schemathesis-http-routes.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Probe the host toolchain. Every failure here is an observation, not a throw. */
function probeToolchain(): SchemathesisToolchainProbe {
  const which = (bin: string): boolean => {
    const r = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' });
    return r.status === 0 && Boolean(r.stdout.trim());
  };

  const pythonPresent = which('python3');

  let moduleVersion: string | null = null;
  if (pythonPresent) {
    const r = spawnSync(
      'python3',
      ['-c', 'import schemathesis, sys; sys.stdout.write(schemathesis.__version__)'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (r.status === 0 && r.stdout.trim()) moduleVersion = r.stdout.trim();
  }

  return { pythonPresent, moduleVersion, pipxPresent: which('pipx') };
}

/** Load the OpenAPI document from a URL or a local path. Null on any failure. */
function loadSchema(location: string): { doc: unknown; detail: string } {
  if (/^https?:\/\//.test(location)) {
    try {
      // curl rather than fetch: the document is multi-megabyte and this keeps
      // the failure modes (DNS, refused, timeout) as one readable exit code.
      const body = execFileSync(
        'curl',
        ['-sS', '--fail', '--max-time', '60', location],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      );
      return { doc: JSON.parse(body), detail: `fetched ${body.length} bytes from ${location}` };
    } catch (err) {
      return { doc: null, detail: `could not fetch ${location}: ${(err as Error).message}` };
    }
  }

  const abs = resolve(ROOT, location);
  if (!existsSync(abs)) return { doc: null, detail: `schema not found: ${abs}` };
  try {
    const body = readFileSync(abs, 'utf8');
    return { doc: JSON.parse(body), detail: `read ${body.length} bytes from ${abs}` };
  } catch (err) {
    return { doc: null, detail: `could not parse ${abs}: ${(err as Error).message}` };
  }
}

/**
 * Read the NDJSON report schemathesis wrote, as raw text.
 *
 * It names the file itself (`ndjson-<UTC timestamp>.ndjson`), so this globs
 * rather than assuming a name. Empty string when nothing was written — which
 * the parser turns into `operationsTested: null`, i.e. a refusal.
 */
function readNdjsonReport(dir: string): string {
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  for (const file of files) {
    try {
      return readFileSync(join(dir, file), 'utf8');
    } catch {
      /* try the next one */
    }
  }
  return '';
}

function main(): number {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };
  const asJson = args.includes('--json');

  const baseUrl = argValue('--url') ?? 'http://127.0.0.1:3070';
  const schemaLocation = argValue('--schema') ?? `${baseUrl}/api/openapi.json`;
  const maxExamples = Number(argValue('--max-examples') ?? '5');
  const includePathRegex = argValue('--include-path-regex');
  const stateful = !args.includes('--no-stateful');

  const toolchain = resolveSchemathesisToolchain(probeToolchain());
  const { doc, detail: schemaDetail } = loadSchema(schemaLocation);
  const surface = summarizeOpenApiSurface(doc);

  let run: SchemathesisRunObservation | null = null;

  // Only spawn when there is something to spawn FOR. A missing toolchain or an
  // unreadable schema is already a refusal; running anyway would just produce a
  // second, less informative failure.
  if (toolchain.available && surface && surface.operations > 0) {
    const built = buildSchemathesisArgv({
      toolchain,
      schemaLocation,
      baseUrl,
      maxExamples,
      includePathRegex,
      stateful,
    });

    if (!built) {
      run = { exitCode: null, operationsTested: null, checksFailed: null, detail: 'no runnable argv' };
    } else {
      const reportDir = mkdtempSync(join(tmpdir(), 'schemathesis-report-'));
      try {
        const r = spawnSync(built.command, [...built.args, '--report-dir', reportDir], {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 30 * 60_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        const parsed = parseSchemathesisReport(readNdjsonReport(reportDir));
        run = {
          exitCode: r.status,
          operationsTested: parsed.operationsTested,
          checksFailed: parsed.checksFailed,
          detail: r.error ? `spawn failed: ${r.error.message}` : parsed.detail,
        };
      } finally {
        rmSync(reportDir, { recursive: true, force: true });
      }
    }
  }

  const verdict = judgeSchemathesisRun({ toolchain, surface, run });

  if (asJson) {
    console.log(JSON.stringify({ schemaLocation, baseUrl, schemaDetail, ...verdict }, null, 2));
  } else {
    console.log(describeSchemathesisVerdict(verdict));
    console.log(`  schema=${schemaLocation}`);
    console.log(`  base-url=${baseUrl}`);
    console.log(`  ${schemaDetail}`);
    console.log(`  toolchain=${toolchain.runner ?? 'none'} version=${toolchain.version ?? 'n/a'} (pin ${SCHEMATHESIS_PIN})`);
    if (surface) {
      console.log(
        `  surface: ${surface.operations} operations over ${surface.paths} paths, ` +
          `${surface.operationsWithSchema} with a schema, ${surface.componentSchemas} component schemas`,
      );
    }
    for (const note of verdict.notes) console.log(`  note: ${note}`);
    if (toolchain.remedy) console.log(`  remedy: ${toolchain.remedy}`);
    if (verdict.decision === 'unavailable') {
      console.log('  UNAVAILABLE is a REFUSAL, not a skip: this gate did not run, so nothing is proven.');
    }
  }

  return schemathesisExitCode(verdict);
}

process.exit(main());
