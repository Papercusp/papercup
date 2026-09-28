/**
 * scripts/share-source.mjs — plan dhh-source-preview-2026-09-28 R-5 / D-004 (P-006).
 *
 * The share tool must only ever grant READ on the ONE preview repository, and
 * must never mutate anything without --confirm (an invite is outward-facing:
 * GitHub emails the invitee). Every case runs against a SHARE_SOURCE_GH stub
 * that logs each call, so no test reaches GitHub.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PREVIEW_REPO, runShare } from '../../../scripts/share-source.mjs';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const BASE = `repos/${PREVIEW_REPO}`;

let tmp: string;
let stub: string;
let log: string;

const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_GH_LOG"
case "$*" in
  *"/invitations --jq"*) printf '%s' "\${STUB_GH_INVITES:-}" ;;
esac
exit "\${STUB_GH_EXIT:-0}"
`;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, SHARE_SOURCE_GH: stub, STUB_GH_LOG: log, ...extra };
}

function calls(): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

function share(argv: string[], extra: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runShare(argv, { env: env(extra), out: (m: string) => out.push(m), err: (m: string) => err.push(m) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'share-source-test-'));
  stub = join(tmp, 'gh');
  writeFileSync(stub, GH_STUB);
  chmodSync(stub, 0o755);
  log = join(tmp, 'gh.log');
});

beforeEach(() => {
  rmSync(log, { force: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('share-source — nothing changes without --confirm', () => {
  it('prints the planned read grant on a dry-run add and calls gh zero times', () => {
    const r = share(['add', 'octo-cat']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry run');
    expect(r.out).toContain(`gh api -X PUT ${BASE}/collaborators/octo-cat -f permission=pull`);
    expect(calls()).toEqual([]);
  });

  it('makes zero calls on a dry-run remove', () => {
    expect(share(['remove', 'octo-cat']).code).toBe(0);
    expect(calls()).toEqual([]);
  });
});

describe('share-source — confirmed actions touch only the preview repo, read-only', () => {
  it('invites with permission=pull on add --confirm', () => {
    const r = share(['add', 'octo-cat', '--confirm']);
    expect(r.code).toBe(0);
    expect(calls()).toEqual([`api -X PUT ${BASE}/collaborators/octo-cat -f permission=pull`]);
    expect(r.out).toContain('read access');
  });

  it('accepts an explicit --permission read and still grants pull', () => {
    expect(share(['add', 'octo-cat', '--permission', 'read', '--confirm']).code).toBe(0);
    expect(calls()).toEqual([`api -X PUT ${BASE}/collaborators/octo-cat -f permission=pull`]);
  });

  it('removes the collaborator and cancels every pending invitation on remove --confirm', () => {
    const r = share(['remove', 'octo-cat', '--confirm'], { STUB_GH_INVITES: '4242\n4343\n' });
    expect(r.code).toBe(0);
    expect(calls()).toEqual([
      `api -X DELETE ${BASE}/collaborators/octo-cat`,
      `api --paginate ${BASE}/invitations --jq .[] | select(.invitee.login == "octo-cat") | .id`,
      `api -X DELETE ${BASE}/invitations/4242`,
      `api -X DELETE ${BASE}/invitations/4343`,
    ]);
    expect(r.out).toContain('cancelled 2 pending invite');
  });

  it('lists collaborators and pending invitations without --confirm', () => {
    expect(share(['list']).code).toBe(0);
    expect(calls().map((c) => c.split(' ')[2])).toEqual([
      `${BASE}/collaborators?affiliation=direct`,
      `${BASE}/invitations`,
    ]);
  });

  it('exits 1 when gh fails', () => {
    const r = share(['add', 'octo-cat', '--confirm'], { STUB_GH_EXIT: '1' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('failed');
  });
});

describe('share-source — refuses anything outside the contract (exit 2, no calls)', () => {
  it.each([
    ['another repository', ['add', 'octo-cat', '--repo', 'Papercusp/papercup', '--confirm']],
    ['write permission', ['add', 'octo-cat', '--permission', 'push', '--confirm']],
    ['admin permission', ['add', 'octo-cat', '--permission', 'admin', '--confirm']],
    ['a flag-shaped username', ['add', '--rf', '--confirm']],
    ['a path-shaped username', ['add', 'octo/../cat', '--confirm']],
    ['a double hyphen', ['add', 'octo--cat', '--confirm']],
    ['a 40-character username', ['add', 'a'.repeat(40), '--confirm']],
    ['a missing username', ['add', '--confirm']],
    ['an unknown action', ['transfer', 'octo-cat', '--confirm']],
    ['a second positional', ['add', 'octo-cat', 'mona', '--confirm']],
  ])('refuses %s', (_label, argv) => {
    const r = share(argv as string[]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^REFUSED:/);
    expect(calls()).toEqual([]);
  });
});

describe('share-source — CLI entry', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'share-source.mjs'), ...args], { encoding: 'utf8', env: env(), cwd: REPO_ROOT });

  it('runs as a script and propagates the exit code', () => {
    expect(cli(['add', 'octo-cat', '--confirm']).status).toBe(0);
    expect(calls()).toEqual([`api -X PUT ${BASE}/collaborators/octo-cat -f permission=pull`]);
    rmSync(log, { force: true });
    const refused = cli(['add', 'octo-cat', '--permission', 'push', '--confirm']);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('only grants read');
    expect(calls()).toEqual([]);
  }, 60_000);
});
