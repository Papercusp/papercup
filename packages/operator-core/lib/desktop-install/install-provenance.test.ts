import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  classifyDowngrade,
  readInstallStamp,
  writeInstallStamp,
  gcStrandedInstallTmp,
  resolveSourceGitProvenance,
  DOWNGRADE_REFUSAL_THRESHOLD_MS,
  INSTALLED_FROM_BASENAME,
  type InstallStamp,
} from './install-provenance';
import { unwritablePath } from '../testing/unwritable-path';

const iso = (msFromEpoch: number) => new Date(msFromEpoch).toISOString();
const DAY = 86_400_000;
const T0 = Date.parse('2026-08-09T00:00:00.000Z');
const run = promisify(execFile);

function stamp(over: Partial<InstallStamp> = {}): InstallStamp {
  return {
    sourceDir: '/canonical/papercusp/apps/operator/scripts/hooks/cc',
    installedAt: iso(T0),
    pid: 1234,
    ...over,
  };
}

describe('classifyDowngrade — fail-open cases (must never block a legitimate install)', () => {
  it('allows when there is no existing stamp (first install, or one predating this code)', () => {
    const v = classifyDowngrade(null, { sourceCommittedAt: iso(T0) });
    expect(v).toEqual({ downgrade: false, reason: 'no-existing-stamp' });
  });

  it('allows when the incoming date is unknown (no git — the packaged app)', () => {
    const v = classifyDowngrade(stamp({ sourceCommittedAt: iso(T0) }), {});
    expect(v).toEqual({ downgrade: false, reason: 'dates-unknown' });
  });

  it('allows when the installed date is unknown', () => {
    const v = classifyDowngrade(stamp(), { sourceCommittedAt: iso(T0) });
    expect(v).toEqual({ downgrade: false, reason: 'dates-unknown' });
  });

  it('allows an unparseable date rather than guessing', () => {
    const v = classifyDowngrade(stamp({ sourceCommittedAt: 'not-a-date' }), {
      sourceCommittedAt: iso(T0),
    });
    expect(v).toEqual({ downgrade: false, reason: 'dates-unknown' });
  });

  it('allows a NEWER source (the ordinary update)', () => {
    const v = classifyDowngrade(stamp({ sourceCommittedAt: iso(T0) }), {
      sourceCommittedAt: iso(T0 + 5 * DAY),
    });
    expect(v).toEqual({ downgrade: false, reason: 'not-older' });
  });

  it('allows a source older by LESS than the threshold — two canonical trees racing by minutes', () => {
    const v = classifyDowngrade(stamp({ sourceCommittedAt: iso(T0) }), {
      sourceCommittedAt: iso(T0 - 30 * 60 * 1000),
    });
    expect(v).toEqual({ downgrade: false, reason: 'not-older' });
  });

  it('allows exactly AT the threshold (boundary is inclusive-allow)', () => {
    const v = classifyDowngrade(stamp({ sourceCommittedAt: iso(T0) }), {
      sourceCommittedAt: iso(T0 - DOWNGRADE_REFUSAL_THRESHOLD_MS),
    });
    expect(v.downgrade).toBe(false);
  });
});

describe('classifyDowngrade — refusals', () => {
  it('refuses the live incident shape: an 8-day-old source over a current install', () => {
    const v = classifyDowngrade(stamp({ sourceCommittedAt: iso(T0) }), {
      sourceCommittedAt: iso(T0 - 8 * DAY),
    });
    expect(v.downgrade).toBe(true);
    if (v.downgrade) expect(v.olderByMs).toBe(8 * DAY);
  });

  it('refuses just past the threshold', () => {
    const v = classifyDowngrade(stamp({ sourceCommittedAt: iso(T0) }), {
      sourceCommittedAt: iso(T0 - DOWNGRADE_REFUSAL_THRESHOLD_MS - 1000),
    });
    expect(v.downgrade).toBe(true);
  });
});

describe('stamp round-trip', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stamp-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes and reads back', async () => {
    const s = stamp({ sourceSha: 'abc123', sourceCommittedAt: iso(T0), files: ['a.sh'] });
    await writeInstallStamp(dir, s);
    expect(await readInstallStamp(dir)).toEqual(s);
  });

  it('leaves no temp file behind', async () => {
    await writeInstallStamp(dir, stamp());
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([INSTALLED_FROM_BASENAME]);
  });

  it('returns null when absent', async () => {
    expect(await readInstallStamp(dir)).toBeNull();
  });

  it('returns null on corrupt JSON rather than throwing (fail-open)', async () => {
    await fs.writeFile(path.join(dir, INSTALLED_FROM_BASENAME), '{not json');
    expect(await readInstallStamp(dir)).toBeNull();
  });

  it('returns null on well-formed JSON of the wrong shape', async () => {
    await fs.writeFile(path.join(dir, INSTALLED_FROM_BASENAME), '[1,2,3]');
    expect(await readInstallStamp(dir)).toBeNull();
  });

  it('never throws on an unwritable dest', async () => {
    await expect(writeInstallStamp(unwritablePath('nonexistent-xyz'), stamp())).resolves.toBeUndefined();
  });
});

describe('gcStrandedInstallTmp', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-gc-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const age = async (name: string, ms: number) => {
    const p = path.join(dir, name);
    await fs.writeFile(p, 'x');
    const when = new Date(Date.now() - ms);
    await fs.utimes(p, when, when);
  };

  it('removes an OLD stranded temp file', async () => {
    await age('pretooluse-locks-acquire.sh.psu-install.999.tmp', 60 * 60 * 1000);
    expect(await gcStrandedInstallTmp(dir)).toEqual([
      'pretooluse-locks-acquire.sh.psu-install.999.tmp',
    ]);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('SPARES a fresh temp file — a concurrent install may be mid-rename', async () => {
    await age('x.sh.psu-install.111.tmp', 1000);
    expect(await gcStrandedInstallTmp(dir)).toEqual([]);
    expect(await fs.readdir(dir)).toHaveLength(1);
  });

  it('never touches real installed hooks, however old', async () => {
    await age('pretooluse-locks-acquire.sh', 90 * DAY);
    await age(INSTALLED_FROM_BASENAME, 90 * DAY);
    expect(await gcStrandedInstallTmp(dir)).toEqual([]);
    expect((await fs.readdir(dir)).sort()).toEqual(
      [INSTALLED_FROM_BASENAME, 'pretooluse-locks-acquire.sh'].sort(),
    );
  });

  it('ignores a lookalike that is not the psu-install temp shape', async () => {
    await age('notes.tmp', 60 * 60 * 1000);
    await age('x.psu-install.notapid.tmp', 60 * 60 * 1000);
    expect(await gcStrandedInstallTmp(dir)).toEqual([]);
  });

  it('returns empty for a missing dir rather than throwing', async () => {
    expect(await gcStrandedInstallTmp(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('resolveSourceGitProvenance', () => {
  it('degrades to {} for a non-repo path instead of throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-nogit-'));
    try {
      // A temp dir is not a git repo; git exits non-zero and we must fail open.
      expect(await resolveSourceGitProvenance(dir)).toEqual({});
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a sha + ISO date for this repo (the canonical case)', async () => {
    const p = await resolveSourceGitProvenance(__dirname);
    // Guarded: if git is unavailable in this environment the contract is still {}.
    if (p.sourceSha) {
      expect(p.sourceSha).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isFinite(Date.parse(p.sourceCommittedAt as string))).toBe(true);
    } else {
      expect(p).toEqual({});
    }
  });

  it('dates the requested source paths instead of an unrelated repository HEAD', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-path-prov-'));
    const sourceDir = path.join(repo, 'apps', 'operator', 'scripts', 'hooks', 'cc');
    try {
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'userpromptsubmit-provenance.sh'), '# hook v1\n');
      await fs.writeFile(path.join(repo, 'unrelated.ts'), 'export const v = 1;\n');
      await run('git', ['init', '-q'], { cwd: repo });
      await run('git', ['config', 'user.name', 'Papercusp Test'], { cwd: repo });
      await run('git', ['config', 'user.email', 'test@papercusp.local'], { cwd: repo });
      await run('git', ['add', '.'], { cwd: repo });
      await run('git', ['commit', '-qm', 'hook'], {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_DATE: iso(T0), GIT_COMMITTER_DATE: iso(T0) },
      });

      await fs.writeFile(path.join(repo, 'unrelated.ts'), 'export const v = 2;\n');
      await run('git', ['add', 'unrelated.ts'], { cwd: repo });
      await run('git', ['commit', '-qm', 'unrelated'], {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: iso(T0 + 5 * DAY),
          GIT_COMMITTER_DATE: iso(T0 + 5 * DAY),
        },
      });

      const pathSpecific = await resolveSourceGitProvenance(sourceDir, [
        'userpromptsubmit-provenance.sh',
      ]);
      expect(pathSpecific.sourceCommittedAt).toBe(iso(T0));
      expect(pathSpecific.sourceSha).toMatch(/^[0-9a-f]{40}$/);

      const repositoryHead = await resolveSourceGitProvenance(sourceDir);
      expect(repositoryHead.sourceCommittedAt).toBe(iso(T0 + 5 * DAY));
      expect(repositoryHead.sourceSha).not.toBe(pathSpecific.sourceSha);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
