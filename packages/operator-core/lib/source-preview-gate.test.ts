/**
 * scripts/source-preview.mjs gate — plan dhh-source-preview-2026-09-28 R-2 (P-003).
 *
 * The gate is fail-closed: every detector must RUN and come back clean. The
 * installer's own audit (audit-release-bundle.py, both legs) runs for real;
 * gitleaks and trufflehog are PATH stubs whose report and exit code each case
 * sets, so the gate's handling of a finding, a crash, an absent binary and a
 * reviewed false positive is pinned without depending on scanner versions.
 *
 * Every case gates a directory under tmpdir; nothing touches the shared checkout.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOWLIST_PATH, PreviewError, loadAllowlist, runGate } from '../../../scripts/source-preview.mjs';
import { childEnv, write } from './source-preview.fixture';

let tmp: string;
let stubs: string;
let clean: string;

// Built at runtime so no credential-shaped literal sits in this file.
const PLANTED = ['gh', 'p_', 'Q7'.repeat(20)].join('');
const FP_SECRET = 'fixture-looking-value-0123456789';

const GITLEAKS_STUB = `#!/usr/bin/env bash
report=""
while [ $# -gt 0 ]; do case "$1" in --report-path) report="$2"; shift ;; esac; shift; done
printf '%s' "\${STUB_GITLEAKS_REPORT:-[]}" > "$report"
exit "\${STUB_GITLEAKS_EXIT:-0}"
`;

const TRUFFLEHOG_STUB = `#!/usr/bin/env bash
printf '%s' "\${STUB_TRUFFLEHOG_OUT:-}"
exit "\${STUB_TRUFFLEHOG_EXIT:-0}"
`;

function stubBin(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  chmodSync(join(dir, name), 0o755);
}

/** Stubs first on PATH, so the real scanners in ~/.local/bin are shadowed. */
function gateEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return childEnv({ PATH: `${stubs}${delimiter}${process.env.PATH ?? ''}`, ...extra });
}

function gitleaksReport(dir: string, findings: { rule: string; file: string; line: number; secret: string }[]): string {
  return JSON.stringify(findings.map((f) => ({
    RuleID: f.rule, File: join(dir, f.file), StartLine: f.line, Secret: f.secret, Match: `key = "${f.secret}"`,
  })));
}

function trufflehogLine(dir: string, detector: string, file: string, line: number, raw: string): string {
  return `${JSON.stringify({ DetectorName: detector, Raw: raw, SourceMetadata: { Data: { Filesystem: { file: join(dir, file), line } } } })}\n`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const byName = (v: Awaited<ReturnType<typeof runGate>>, name: string) => v.results.find((r) => r.name === name);

async function allowlistFile(entries: unknown): Promise<string> {
  const p = join(tmp, `allowlist-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(entries));
  return p;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'source-preview-gate-test-'));
  stubs = join(tmp, 'stubs');
  stubBin(stubs, 'gitleaks', GITLEAKS_STUB);
  stubBin(stubs, 'trufflehog', TRUFFLEHOG_STUB);
  clean = join(tmp, 'clean');
  write(clean, 'README.md', '# preview\n');
  write(clean, 'src/index.ts', 'export const answer = 42;\n');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('source-preview gate — every detector runs and a clean tree passes', () => {
  it('passes a clean tree with all four detectors clean', async () => {
    const v = await runGate(clean, { env: gateEnv(), allowlistPath: join(tmp, 'none.json') });
    expect(v.results.map((r) => [r.name, r.status])).toEqual([
      ['audit-release-bundle', 'clean'],
      ['audit-release-bundle --scan-dir', 'clean'],
      ['gitleaks', 'clean'],
      ['trufflehog', 'clean'],
    ]);
    expect(v).toMatchObject({ ok: true, exitCode: 0 });
  }, 120_000);

  it('refuses a planted token through the installer audit even when both extra scanners are silent', async () => {
    const dir = join(tmp, 'planted');
    write(dir, 'README.md', '# preview\n');
    write(dir, 'src/config.ts', `export const token = '${PLANTED}';\n`);
    const v = await runGate(dir, { env: gateEnv(), allowlistPath: join(tmp, 'none.json') });
    expect(byName(v, 'audit-release-bundle --scan-dir')?.status).toBe('finding');
    expect(v).toMatchObject({ ok: false, exitCode: 1 });
  }, 120_000);
});

describe('source-preview gate — extra detectors', () => {
  it('refuses a gitleaks finding and reports it by SHA-256, never by value', async () => {
    const env = gateEnv({
      STUB_GITLEAKS_EXIT: '1',
      STUB_GITLEAKS_REPORT: gitleaksReport(clean, [{ rule: 'generic-api-key', file: 'src/index.ts', line: 1, secret: FP_SECRET }]),
    });
    const v = await runGate(clean, { env, allowlistPath: join(tmp, 'none.json') });
    expect(byName(v, 'gitleaks')?.status).toBe('finding');
    expect(v).toMatchObject({ ok: false, exitCode: 1 });
    expect(v.findings).toEqual([{
      detector: 'gitleaks', rule: 'generic-api-key', path: 'src/index.ts', line: 1, sha256: sha256(FP_SECRET), allowlisted: false,
    }]);
    expect(JSON.stringify(v)).not.toContain(FP_SECRET);
  }, 120_000);

  it('refuses a trufflehog finding (exit 183)', async () => {
    const env = gateEnv({ STUB_TRUFFLEHOG_EXIT: '183', STUB_TRUFFLEHOG_OUT: trufflehogLine(clean, 'URI', 'src/index.ts', 1, FP_SECRET) });
    const v = await runGate(clean, { env, allowlistPath: join(tmp, 'none.json') });
    expect(byName(v, 'trufflehog')?.status).toBe('finding');
    expect(v.findings).toEqual([{
      detector: 'trufflehog', rule: 'URI', path: 'src/index.ts', line: 1, sha256: sha256(FP_SECRET), allowlisted: false,
    }]);
    expect(v).toMatchObject({ ok: false, exitCode: 1 });
  }, 120_000);

  it('accepts a reviewed false positive only for the exact value it was reviewed for', async () => {
    const allowlistPath = await allowlistFile({ entries: [{
      detector: 'gitleaks', rule: 'generic-api-key', path: 'src/index.ts', sha256: sha256(FP_SECRET), reason: 'fixture value',
    }] });
    const report = (secret: string) => gateEnv({
      STUB_GITLEAKS_EXIT: '1',
      STUB_GITLEAKS_REPORT: gitleaksReport(clean, [{ rule: 'generic-api-key', file: 'src/index.ts', line: 1, secret }]),
    });

    const accepted = await runGate(clean, { env: report(FP_SECRET), allowlistPath });
    expect(byName(accepted, 'gitleaks')).toMatchObject({ status: 'clean', ok: true });
    expect(byName(accepted, 'gitleaks')?.detail).toMatch(/1 reviewed false positive\(s\) accepted/);
    expect(accepted.findings?.[0]?.allowlisted).toBe(true);
    expect(accepted).toMatchObject({ ok: true, exitCode: 0 });

    const changed = await runGate(clean, { env: report(`${FP_SECRET}-rotated`), allowlistPath });
    expect(byName(changed, 'gitleaks')?.status).toBe('finding');
    expect(changed).toMatchObject({ ok: false, exitCode: 1 });
  }, 120_000);
});

describe('source-preview gate — a detector that cannot run refuses (exit 2)', () => {
  it('refuses when gitleaks is not on PATH instead of skipping it', async () => {
    const onlyTruffle = join(tmp, 'stubs-no-gitleaks');
    stubBin(onlyTruffle, 'trufflehog', TRUFFLEHOG_STUB);
    const rest = (process.env.PATH ?? '').split(delimiter).filter((d) => d && !existsSync(join(d, 'gitleaks')));
    const v = await runGate(clean, { env: childEnv({ PATH: [onlyTruffle, ...rest].join(delimiter) }), allowlistPath: join(tmp, 'none.json') });
    expect(v.results).toEqual([expect.objectContaining({ name: 'gitleaks', status: 'cannot-check', ok: false })]);
    expect(v).toMatchObject({ ok: false, exitCode: 2 });
  }, 120_000);

  it('refuses when gitleaks crashes', async () => {
    const v = await runGate(clean, { env: gateEnv({ STUB_GITLEAKS_EXIT: '3' }), allowlistPath: join(tmp, 'none.json') });
    expect(byName(v, 'gitleaks')?.status).toBe('cannot-check');
    expect(v).toMatchObject({ ok: false, exitCode: 2 });
  }, 120_000);

  it('refuses when gitleaks reports a leak but lists no finding', async () => {
    const v = await runGate(clean, { env: gateEnv({ STUB_GITLEAKS_EXIT: '1' }), allowlistPath: join(tmp, 'none.json') });
    expect(byName(v, 'gitleaks')?.status).toBe('cannot-check');
    expect(v.exitCode).toBe(2);
  }, 120_000);

  it('refuses unparsable trufflehog output', async () => {
    const v = await runGate(clean, { env: gateEnv({ STUB_TRUFFLEHOG_EXIT: '183', STUB_TRUFFLEHOG_OUT: 'not json\n' }), allowlistPath: join(tmp, 'none.json') });
    expect(byName(v, 'trufflehog')?.status).toBe('cannot-check');
    expect(v.exitCode).toBe(2);
  }, 120_000);

  it('refuses a directory that does not exist', async () => {
    await expect(runGate(join(tmp, 'missing'), { env: gateEnv(), allowlistPath: join(tmp, 'none.json') }))
      .rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('source-preview allowlist — every entry is a reviewed, exact fingerprint', () => {
  const entry = { detector: 'gitleaks', rule: 'generic-api-key', path: 'src/index.ts', sha256: sha256(FP_SECRET), reason: 'fixture value' };

  it('treats a missing allowlist as empty', async () => {
    expect(await loadAllowlist(join(tmp, 'absent.json'))).toEqual([]);
  });

  it('rejects an entry without a reason', async () => {
    const p = await allowlistFile({ entries: [{ ...entry, reason: ' ' }] });
    await expect(loadAllowlist(p)).rejects.toThrow(PreviewError);
    await expect(loadAllowlist(p)).rejects.toThrow(/non-empty reason/);
  });

  it('rejects an entry whose sha256 is not a full digest', async () => {
    const p = await allowlistFile({ entries: [{ ...entry, sha256: entry.sha256.slice(0, 12) }] });
    await expect(loadAllowlist(p)).rejects.toThrow(/64 hex/);
  });

  it('ships a valid, duplicate-free allowlist of repo-relative paths', async () => {
    const entries = await loadAllowlist(ALLOWLIST_PATH);
    expect(entries.length).toBeGreaterThan(0);
    const keys = entries.map((e) => `${e.detector}|${e.rule}|${e.path}|${e.sha256}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of entries) {
      expect(['gitleaks', 'trufflehog'], e.path).toContain(e.detector);
      expect(e.path.startsWith('/') || e.path.split('/').includes('..'), e.path).toBe(false);
    }
  });
});
