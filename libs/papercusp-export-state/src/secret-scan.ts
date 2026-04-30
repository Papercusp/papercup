/**
 * Two-tier secret scan — §15.9.
 *
 *   Tier A (BLOCK): trufflehog --only-verified — runs detectors that
 *     validate suspected secrets against live APIs. ~700 detector types.
 *     Any verified hit BLOCKS the publish unless caller opts in.
 *
 *   Tier B (WARN): gitleaks — high-recall pattern matching. False
 *     positives are real (~10-30%); user triages each in the review UI.
 *
 * The `--only-verified` mode in trufflehog produces NDJSON on stdout.
 * gitleaks emits JSON on stdout via `--report-format json` to a file.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { SecretScanResult, VerifiedSecretHit } from './capture-types';

interface RunOpts {
  signal?: AbortSignal;
}

function spawnCollect(
  cmd: string,
  args: string[],
  opts: RunOpts,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => reject(e));
    opts.signal?.addEventListener('abort', () => child.kill('SIGTERM'));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function trufflehogVerified(
  scanRoot: string,
  opts: RunOpts = {},
): Promise<VerifiedSecretHit[]> {
  // trufflehog filesystem <path> --only-verified --json
  const r = await spawnCollect(
    'trufflehog',
    ['filesystem', scanRoot, '--only-verified', '--json', '--no-update'],
    opts,
  );
  // Exit code 0: clean run (with or without findings). Non-zero: error.
  // Findings are NDJSON on stdout.
  if (r.code !== 0 && r.code !== 183 /* findings flag in some versions */) {
    if (!r.stdout) {
      throw new Error(`trufflehog failed (code ${r.code}): ${r.stderr.trim()}`);
    }
    // Some versions return non-zero on findings; fall through and parse.
  }
  return parseTrufflehogNdjson(r.stdout, scanRoot);
}

function parseTrufflehogNdjson(stdout: string, scanRoot: string): VerifiedSecretHit[] {
  const out: VerifiedSecretHit[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const sm = (obj.SourceMetadata ?? {}) as Record<string, unknown>;
    const data = (sm.Data ?? {}) as Record<string, unknown>;
    const fs = (data.Filesystem ?? {}) as Record<string, unknown>;
    const file = typeof fs.file === 'string' ? fs.file : null;
    const detectorName =
      typeof obj.DetectorName === 'string' ? obj.DetectorName : 'unknown';
    const raw = typeof obj.Raw === 'string' ? obj.Raw : '';
    out.push({
      file: file ? relativeFile(file, scanRoot) : '<unknown>',
      detector: detectorName,
      redactedSnippet: redact(raw),
    });
  }
  return out;
}

function relativeFile(p: string, root: string): string {
  if (p.startsWith(root + '/')) return p.slice(root.length + 1);
  return p;
}

function redact(s: string): string {
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

export async function gitleaksHighRecall(
  scanRoot: string,
  opts: RunOpts = {},
): Promise<VerifiedSecretHit[]> {
  const reportPath = join(scanRoot, '.papercusp-gitleaks-report.json');
  // gitleaks 8.x: `gitleaks dir <path> --report-path <p> --report-format json --no-banner --redact`
  // Some versions use `gitleaks detect --source <path>`; try `dir` first then fall back.
  let r = await spawnCollect(
    'gitleaks',
    ['dir', scanRoot, '--report-path', reportPath, '--report-format', 'json', '--no-banner', '--redact'],
    opts,
  );
  if (r.code !== 0 && r.code !== 1) {
    // Older syntax fallback
    r = await spawnCollect(
      'gitleaks',
      ['detect', '--source', scanRoot, '--report-path', reportPath, '--report-format', 'json', '--no-banner', '--redact', '--no-git'],
      opts,
    );
  }
  // gitleaks: 0 = no leaks, 1 = leaks found, 2 = error.
  if (r.code === 2) {
    throw new Error(`gitleaks failed: ${r.stderr.trim()}`);
  }
  let raw: string;
  try {
    raw = await fs.readFile(reportPath, 'utf8');
  } catch {
    return [];
  }
  await fs.unlink(reportPath).catch(() => {});
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => {
    const it = item as Record<string, unknown>;
    return {
      file: typeof it.File === 'string' ? relativeFile(it.File, scanRoot) : '<unknown>',
      line: typeof it.StartLine === 'number' ? it.StartLine : undefined,
      detector: typeof it.RuleID === 'string' ? it.RuleID : 'unknown',
      redactedSnippet:
        typeof it.Match === 'string' ? redact(it.Match) : '****',
    } satisfies VerifiedSecretHit;
  });
}

export async function scanForSecrets(
  scanRoot: string,
  opts: RunOpts = {},
): Promise<SecretScanResult> {
  const [verifiedHits, highRecallHits] = await Promise.all([
    trufflehogVerified(scanRoot, opts).catch((e) => {
      throw new Error(`trufflehog scan failed: ${(e as Error).message}`);
    }),
    gitleaksHighRecall(scanRoot, opts).catch((e) => {
      throw new Error(`gitleaks scan failed: ${(e as Error).message}`);
    }),
  ]);
  return { verifiedHits, highRecallHits };
}

export class VerifiedSecretsBlocked extends Error {
  constructor(public hits: VerifiedSecretHit[]) {
    super(
      `${hits.length} verified secret(s) found in snapshot staging. ` +
        `Resolve or pass acceptVerifiedSecrets=true to override.`,
    );
    this.name = 'VerifiedSecretsBlocked';
  }
}
