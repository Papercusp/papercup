/**
 * session-dir-gc.test.ts — the per-session isolation-dir janitor (the EI-155
 * follow-on; source `session-dir-gc.ts`).
 *
 * Two layers:
 *   - the PURE planner / classifiers (no fs/PG, injected clock) — the keep vs
 *     collect decision + the protected-set + key matching;
 *   - the FS sweep against tmp roots with an injected protected set + clock,
 *     incl. the symlink-mirror safety invariant (rm unlinks links, never follows
 *     them into the real `~/.claude`).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION_MS,
  discoverSessionDirCandidates,
  isProtected,
  planSessionDirGc,
  sessionDirKey,
  sweepStaleSessionDirs,
  type ProtectedSessionIdentity,
  type SessionDirCandidate,
  type SessionDirRoot,
} from './session-dir-gc';

const NOW = 1_780_000_000_000; // fixed injected clock (ms)
const empty: ProtectedSessionIdentity = { ownerIds: new Set(), sessionKeys: new Set() };

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'session-dir-gc-test-'));
  cleanups.push(d);
  return d;
}
/** A child dir under `root` with its mtime set `ageMs` in the past relative to NOW. */
function seedDir(root: string, name: string, ageMs: number): string {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  const sec = (NOW - ageMs) / 1000;
  utimesSync(p, sec, sec);
  return p;
}

describe('sessionDirKey', () => {
  it('owner roots use the name verbatim; session roots strip the session- prefix', () => {
    expect(sessionDirKey('su-1c079ae0-b17d', 'owner')).toBe('su-1c079ae0-b17d');
    expect(sessionDirKey('s-1780813923126-d6fffc0a', 'owner')).toBe('s-1780813923126-d6fffc0a');
    expect(sessionDirKey('session-637', 'session')).toBe('637');
    // defensive: a session root dir without the prefix → used whole
    expect(sessionDirKey('weird', 'session')).toBe('weird');
  });
});

describe('isProtected', () => {
  const prot: ProtectedSessionIdentity = {
    ownerIds: new Set(['su-alive']),
    sessionKeys: new Set(['637']),
  };
  it('matches owner-keyed dirs against ownerIds', () => {
    expect(isProtected({ keyKind: 'owner', key: 'su-alive' }, prot)).toBe(true);
    expect(isProtected({ keyKind: 'owner', key: 'su-dead' }, prot)).toBe(false);
  });
  it('matches session-keyed dirs against sessionKeys (never cross-matches owners)', () => {
    expect(isProtected({ keyKind: 'session', key: '637' }, prot)).toBe(true);
    expect(isProtected({ keyKind: 'session', key: '999' }, prot)).toBe(false);
    // an owner id is never a session key and vice-versa
    expect(isProtected({ keyKind: 'session', key: 'su-alive' }, prot)).toBe(false);
  });
});

describe('planSessionDirGc', () => {
  const mk = (key: string, keyKind: 'owner' | 'session', ageMs: number): SessionDirCandidate => ({
    path: `/fake/${keyKind}/${key}`,
    keyKind,
    key,
    mtimeMs: NOW - ageMs,
  });
  const RET = DEFAULT_RETENTION_MS;

  it('keeps protected dirs regardless of age', () => {
    const prot: ProtectedSessionIdentity = { ownerIds: new Set(['su-live']), sessionKeys: new Set() };
    const plan = planSessionDirGc({
      candidates: [mk('su-live', 'owner', RET * 100)], // ancient but live
      protectedIdentity: prot,
      nowMs: NOW,
      retentionMs: RET,
    });
    expect(plan.keptProtected.map((c) => c.key)).toEqual(['su-live']);
    expect(plan.remove).toEqual([]);
  });

  it('keeps a fresh unprotected dir, removes a stale one', () => {
    const plan = planSessionDirGc({
      candidates: [
        mk('su-fresh', 'owner', RET / 2), // within retention → kept
        mk('su-stale', 'owner', RET * 2), // past retention, not protected → removed
        mk('637', 'session', RET * 3), // stale codex home → removed
      ],
      protectedIdentity: empty,
      nowMs: NOW,
      retentionMs: RET,
    });
    expect(plan.keptFresh.map((c) => c.key)).toEqual(['su-fresh']);
    expect(plan.remove.map((c) => c.key).sort()).toEqual(['637', 'su-stale']);
  });

  it('collects at the retention boundary (age >= retention), keeps just under it', () => {
    const plan = planSessionDirGc({
      candidates: [
        mk('su-under', 'owner', RET - 1), // just inside the window → kept
        mk('su-edge', 'owner', RET), // age === retention → collectible
      ],
      protectedIdentity: empty,
      nowMs: NOW,
      retentionMs: RET,
    });
    expect(plan.keptFresh.map((c) => c.key)).toEqual(['su-under']);
    expect(plan.remove.map((c) => c.key)).toEqual(['su-edge']);
  });
});

describe('discoverSessionDirCandidates', () => {
  it('finds child dirs with mtimes, skips files, and skips absent roots', () => {
    const claude = tmpRoot();
    seedDir(claude, 'su-aaa', 1000);
    seedDir(claude, 'su-bbb', 2000);
    writeFileSync(join(claude, 'stray-file'), 'x'); // a file, not a session dir

    const roots: SessionDirRoot[] = [
      { root: claude, keyKind: 'owner', label: 'claude' },
      { root: join(claude, 'does-not-exist'), keyKind: 'session', label: 'absent' },
    ];
    const cands = discoverSessionDirCandidates(roots);
    expect(cands.map((c) => c.key).sort()).toEqual(['su-aaa', 'su-bbb']);
    expect(cands.every((c) => c.keyKind === 'owner' && typeof c.mtimeMs === 'number')).toBe(true);
  });
});

describe('sweepStaleSessionDirs', () => {
  function setup() {
    const claude = tmpRoot();
    const codex = tmpRoot();
    const live = seedDir(claude, 'su-live', DEFAULT_RETENTION_MS * 5); // ancient but protected
    const fresh = seedDir(claude, 'su-fresh', 1000); // within retention
    const stale = seedDir(claude, 'su-stale', DEFAULT_RETENTION_MS * 2); // collectible
    const codexOpen = seedDir(codex, 'session-700', DEFAULT_RETENTION_MS * 2); // protected key
    const codexStale = seedDir(codex, 'session-42', DEFAULT_RETENTION_MS * 2); // collectible
    const roots: SessionDirRoot[] = [
      { root: claude, keyKind: 'owner', label: 'session-claude' },
      { root: codex, keyKind: 'session', label: 'su-codex-homes' },
    ];
    const prot: ProtectedSessionIdentity = {
      ownerIds: new Set(['su-live']),
      sessionKeys: new Set(['700']),
    };
    return { roots, prot, live, fresh, stale, codexOpen, codexStale };
  }

  it('removes only stale unprotected dirs; keeps live + fresh + protected-key', () => {
    const { roots, prot, live, fresh, stale, codexOpen, codexStale } = setup();
    const res = sweepStaleSessionDirs({ protectedIdentity: prot, roots, nowMs: NOW });

    expect(res.removed.sort()).toEqual([stale, codexStale].sort());
    expect(res.keptProtected).toBe(2); // su-live + session-700
    expect(res.keptFresh).toBe(1); // su-fresh
    expect(res.errors).toEqual([]);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(codexStale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(codexOpen)).toBe(true);
  });

  it('dryRun plans the same removals but deletes nothing', () => {
    const { roots, prot, stale, codexStale } = setup();
    const res = sweepStaleSessionDirs({ protectedIdentity: prot, roots, nowMs: NOW, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.removed.sort()).toEqual([stale, codexStale].sort());
    expect(existsSync(stale)).toBe(true); // not actually removed
    expect(existsSync(codexStale)).toBe(true);
  });

  it('SAFETY: removing a symlink-mirror dir unlinks the links, never the real targets', () => {
    // A real "~/.claude" the session-claude dir mirrors.
    const realClaude = tmpRoot();
    const realCreds = join(realClaude, '.credentials.json');
    const realPlugins = join(realClaude, 'plugins');
    writeFileSync(realCreds, 'SECRET-OAUTH');
    mkdirSync(realPlugins, { recursive: true });
    writeFileSync(join(realPlugins, 'skill.txt'), 'a skill');

    // A stale session-claude dir: symlinks back to the real entries + a real
    // isolated projects/ holding this session's transcript.
    const claudeRoot = tmpRoot();
    const sessionDir = seedDir(claudeRoot, 'su-stale', DEFAULT_RETENTION_MS * 2);
    symlinkSync(realCreds, join(sessionDir, '.credentials.json'));
    symlinkSync(realPlugins, join(sessionDir, 'plugins'));
    const projects = join(sessionDir, 'projects', 'slug');
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 'transcript.jsonl'), '{"line":1}');
    // re-stamp the (now mutated) dir mtime back into the past so it's collectible
    const past = (NOW - DEFAULT_RETENTION_MS * 2) / 1000;
    utimesSync(sessionDir, past, past);

    const res = sweepStaleSessionDirs({
      protectedIdentity: empty,
      roots: [{ root: claudeRoot, keyKind: 'owner', label: 'session-claude' }],
      nowMs: NOW,
    });

    expect(res.removed).toEqual([sessionDir]);
    expect(existsSync(sessionDir)).toBe(false); // the session dir (+ its links + projects/) gone
    // the REAL targets the symlinks pointed at survive untouched
    expect(existsSync(realCreds)).toBe(true);
    expect(readFileSync(realCreds, 'utf8')).toBe('SECRET-OAUTH');
    expect(existsSync(join(realPlugins, 'skill.txt'))).toBe(true);
    expect(lstatSync(realPlugins).isDirectory()).toBe(true);
  });
});
