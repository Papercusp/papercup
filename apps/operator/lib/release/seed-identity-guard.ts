/**
 * EI-20108164746219771 step 4 — refuse to STAGE a seed that carries the build box's
 * identity, measured on the bytes, at cut time.
 *
 * ── WHY A FILE-LEVEL ASSERTION AND NOT ANOTHER CONTENT FILTER ──
 * Two identity leaks reached a shipped seed by two unrelated routes, and each fix is blind
 * to the other. `SEED_EXCLUDED_TABLES` + the shipped-suffix guard removed the `presence`
 * ROWS (hypercore content). `seed-hostname-neutralization.ts` stopped RocksDB stamping
 * `host.identity` into every SST (a table property, not content). Neither could have caught
 * the other, and a THIRD mechanism that stamps the box into some future file would be caught
 * by neither. This guard is deliberately mechanism-agnostic: it reads the staged bytes and
 * asks the only question that actually matters — is the owner's identity in there.
 *
 * ── WHY NOT SHELL OUT TO audit-release-bundle.py --scan-dir ──
 * ⛔ That path would PASS on exactly the bytes this must catch. Its
 * `_seed_corestore_owner_authorised()` deliberately ACCEPTS `build-hostname` and
 * `build-user-name` under `/seed/corestore/` as an owner-authorised machine label — which
 * is correct for its job (auditing a SOURCE tree the owner controls) and useless for ours.
 * The identical bytes red only once they are inside a `.deb` archive member, i.e. after a
 * whole release has been built. So we derive the same literal set the same way and apply
 * NO acceptance at all: this runs on the seed the installer is about to be built FROM.
 *
 * ── THE LITERAL SET IS DERIVED, NEVER WRITTEN DOWN ──
 * Mirrors `identity_literals()` in `papercusp-desktop/bin/audit-release-bundle.py`
 * (build-user-name / build-home-path / build-hostname / build-git-name / build-git-email),
 * including its two matching asymmetries — see {@link needsWordBoundary}. A tracked source
 * file must never contain the real values (WI-4776): they are resolved at runtime here and
 * synthesised in the tests.
 *
 * ── WHY THE GIT HALF DOES NOT FALSE-POSITIVE (measured, not assumed) ──
 * A seed also ships git bundles, and every commit object in them carries an author name and
 * email — i.e. two of the five literals, by the thousand. They do not trip this guard because
 * pack objects are DEFLATED, so the names are not present as plaintext. That is an empirical
 * property, not a guarantee: MEASURED 2026-08-11 against the real committed seed — 54 files
 * scanned, 4 hits, ALL of them in `corestore/db/`, none in a bundle. If a future change ships
 * loose objects or an uncompressed pack, expect this guard to start firing on the git half —
 * and the correct response is a bundle-aware exemption for AUTHORSHIP metadata specifically,
 * never dropping build-git-name / build-git-email from the literal set (they are exactly the
 * strings the owner asked to keep out of a public build).
 *
 * ── THE SANDBOX WRINKLE (read before changing the hostname handling) ──
 * The cut re-execs under `bwrap --unshare-uts --hostname papercusp-build`, so inside it
 * `os.hostname()` returns the NEUTRAL name, not the real one. Two consequences, both
 * load-bearing:
 *   1. The neutral hostname is BY CONSTRUCTION published in every SST — it is the fix, not
 *      a leak — so it is never scanned for.
 *   2. The REAL hostname is therefore unknowable from inside the namespace. The re-exec
 *      passes it down in {@link SEED_REAL_HOSTNAME_ENV}; if that is missing while we are
 *      demonstrably inside the namespace, we CANNOT prove the real hostname is absent, and
 *      the guard refuses rather than reporting a clean it did not measure.
 */

import { hostname as osHostname, userInfo } from 'node:os';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Carries the REAL build hostname across the `bwrap --unshare-uts` boundary, because
 * `gethostname()` inside the namespace answers with the neutral label instead.
 */
export const SEED_REAL_HOSTNAME_ENV = 'PAPERCUSP_SEED_REAL_HOSTNAME';

/** Identity keys, named exactly as `audit-release-bundle.py` names them. */
export type IdentityKey =
  | 'build-user-name'
  | 'build-home-path'
  | 'build-hostname'
  | 'build-git-name'
  | 'build-git-email';

export type IdentityLiterals = ReadonlyMap<IdentityKey, string>;

/** Generic account names that identify a CI runner, not a person. Same set as the python gate. */
const IMPERSONAL_USERS = new Set(['root', 'runner', 'build', 'ubuntu']);
const IMPERSONAL_HOMES = new Set(['/root', '/', '/home']);
const IMPERSONAL_HOST_PREFIXES = ['runner', 'ci-', 'localhost'];

/**
 * A SHORT literal must match as a whole word or it matches half the seed.
 *
 * The owner's git `user.name` on this box is a THREE-LETTER first name — the exact string
 * they asked to keep out of a public build. Substring-matching it would fire on every video
 * file extension in vendored bytes; skipping it would make the owner's own example the one
 * identity we cannot catch. So short alphanumeric literals match on a word boundary, and are
 * additionally scanned in TEXT files only (see {@link isLowEntropy}) — byte-for-byte the
 * asymmetry the python gate uses, so the two cannot disagree about what counts as a hit.
 */
export function needsWordBoundary(lit: string): boolean {
  return lit.length < 6 && /^[a-zA-Z0-9]+$/.test(lit);
}

/**
 * A literal so short that RANDOM BINARY hits it by coincidence. In a compressed SST every
 * 3-byte sequence occurs; `\bAvi\b` over 85 MiB of entropy is a guaranteed false positive,
 * which is how a gate gets switched off. High-entropy literals (a home path, a username, a
 * hostname, an email) are hunted everywhere, binary included — those are the ones that
 * actually leak.
 */
export function isLowEntropy(lit: string): boolean {
  return needsWordBoundary(lit);
}

function gitConfig(key: string, cwd?: string): string | undefined {
  try {
    const v = execFileSync('git', ['config', '--get', key], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cwd ? { cwd } : {}),
    }).trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

export type ResolveIdentityInput = {
  readonly env?: Record<string, string | undefined>;
  /** The hostname the cut publishes on purpose; never scanned for. */
  readonly neutralHostname: string;
  /** Overrides for tests — never pass these from the release path. */
  readonly probe?: {
    readonly user?: () => string | undefined;
    readonly home?: () => string | undefined;
    readonly hostname?: () => string | undefined;
    readonly gitName?: () => string | undefined;
    readonly gitEmail?: () => string | undefined;
  };
};

/**
 * Resolve the machine identity as literal strings, from the box doing the build.
 *
 * `unknownHostname` is the fail-closed signal: true means we are inside the neutralized
 * namespace with no real hostname handed down, so "no hostname found" would be a statement
 * about the sandbox rather than about the build box.
 */
export function resolveIdentityLiterals(inp: ResolveIdentityInput): {
  readonly literals: IdentityLiterals;
  readonly unknownHostname: boolean;
} {
  const env = inp.env ?? process.env;
  const probe = inp.probe ?? {};
  const literals = new Map<IdentityKey, string>();

  const user = (probe.user ?? (() => safe(() => userInfo().username)))();
  if (user && !IMPERSONAL_USERS.has(user)) literals.set('build-user-name', user);

  const home = (probe.home ?? (() => safe(() => homedir())))();
  if (home && !IMPERSONAL_HOMES.has(home)) literals.set('build-home-path', home);

  const observedHost = (probe.hostname ?? (() => safe(() => osHostname())))();
  const realHost = env[SEED_REAL_HOSTNAME_ENV] || observedHost;
  // The neutral label is the FIX, published deliberately in every SST — scanning for it
  // would fail every correctly-neutralized cut.
  const hostIsNeutral = !!realHost && realHost === inp.neutralHostname;
  const unknownHostname = !!observedHost && observedHost === inp.neutralHostname && !env[SEED_REAL_HOSTNAME_ENV];
  if (
    realHost &&
    !hostIsNeutral &&
    !IMPERSONAL_HOST_PREFIXES.some((p) => realHost.startsWith(p))
  ) {
    literals.set('build-hostname', realHost);
  }

  const gitName = (probe.gitName ?? (() => gitConfig('user.name')))();
  if (gitName) literals.set('build-git-name', gitName);
  const gitEmail = (probe.gitEmail ?? (() => gitConfig('user.email')))();
  if (gitEmail) literals.set('build-git-email', gitEmail);

  return { literals, unknownHostname };
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/** How much of a file we sniff for NUL bytes to call it binary — grep's own heuristic. */
const BINARY_SNIFF_BYTES = 8192;
const CHUNK_BYTES = 4 * 1024 * 1024;

export type IdentityFinding = {
  readonly file: string;
  readonly key: IdentityKey;
  /** Byte offset of the first hit — proof the finding is a real position, not a guess. */
  readonly offset: number;
  readonly binary: boolean;
};

/**
 * Scan ONE file. Reads in bounded chunks with an overlap, so an 85 MiB SST costs a few MB of
 * RSS and a literal straddling a chunk boundary is still found.
 */
export async function scanFileForIdentity(path: string, literals: IdentityLiterals): Promise<IdentityFinding[]> {
  const entries = [...literals.entries()];
  if (entries.length === 0) return [];
  const findings: IdentityFinding[] = [];
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(head, 0, BINARY_SNIFF_BYTES, 0);
    const binary = head.subarray(0, bytesRead).includes(0);
    // Low-entropy literals are TEXT-ONLY: see isLowEntropy.
    const applicable = entries.filter(([, lit]) => !binary || !isLowEntropy(lit));
    if (applicable.length === 0) return [];

    const maxLit = Math.max(...applicable.map(([, lit]) => lit.length));
    const overlap = Math.max(0, maxLit + 1);
    let position = 0;
    let carry = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK_BYTES);
    const seen = new Set<IdentityKey>();
    for (;;) {
      const { bytesRead: n } = await fh.read(buf, 0, CHUNK_BYTES, position);
      if (n <= 0) break;
      const window = Buffer.concat([carry, buf.subarray(0, n)]);
      const windowStart = position - carry.length;
      const text = window.toString('latin1');
      for (const [key, lit] of applicable) {
        if (seen.has(key)) continue;
        const idx = needsWordBoundary(lit) ? wordBoundaryIndex(text, lit) : text.indexOf(lit);
        if (idx >= 0) {
          seen.add(key);
          findings.push({ file: path, key, offset: windowStart + idx, binary });
        }
      }
      position += n;
      if (seen.size === applicable.length) break;
      carry = window.subarray(Math.max(0, window.length - overlap));
    }
  } finally {
    await fh.close();
  }
  return findings;
}

/** Case-sensitive `\blit\b`, matching the python gate's `lit_ere()`. */
function wordBoundaryIndex(haystack: string, lit: string): number {
  const re = new RegExp(`\\b${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const m = re.exec(haystack);
  return m ? m.index : -1;
}

/** Walk every regular file under `dir` (symlinks are not followed — a seed contains none). */
export async function listSeedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let ents;
    try {
      ents = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

export type SeedIdentityVerdict = {
  readonly ok: boolean;
  readonly findings: readonly IdentityFinding[];
  readonly literalKeys: readonly IdentityKey[];
  readonly filesScanned: number;
  readonly message: string;
};

export async function judgeSeedIdentity(inp: {
  readonly dir: string;
  readonly literals: IdentityLiterals;
}): Promise<SeedIdentityVerdict> {
  const files = await listSeedFiles(inp.dir);
  const findings: IdentityFinding[] = [];
  for (const f of files) findings.push(...(await scanFileForIdentity(f, inp.literals)));
  const literalKeys = [...inp.literals.keys()];
  if (findings.length === 0) {
    return {
      ok: true,
      findings,
      literalKeys,
      filesScanned: files.length,
      message:
        `[seed-identity] clean — ${files.length} staged file(s) carry none of ` +
        `${literalKeys.length} build-identity literal(s) [${literalKeys.join(', ')}].`,
    };
  }
  const byFile = new Map<string, IdentityFinding[]>();
  for (const f of findings) {
    const rel = relative(inp.dir, f.file) || f.file;
    byFile.set(rel, [...(byFile.get(rel) ?? []), f]);
  }
  const detail = [...byFile.entries()]
    .map(([rel, fs]) => `    • ${rel} — ${fs.map((f) => `${f.key}@${f.offset}${f.binary ? ' (binary)' : ''}`).join(', ')}`)
    .join('\n');
  return {
    ok: false,
    findings,
    literalKeys,
    filesScanned: files.length,
    message:
      `[seed-identity] ⛔ THE STAGED SEED CARRIES THE BUILD BOX'S IDENTITY — refusing to stage it.\n` +
      `  ${findings.length} hit(s) across ${byFile.size} file(s) in ${inp.dir}:\n${detail}\n` +
      `  This seed would ship inside every installer. There is NO acceptance path here: the same\n` +
      `  bytes are accepted by audit-release-bundle.py --scan-dir (owner-authorised machine label)\n` +
      `  and RED once they are inside a .deb archive member, which is why this must refuse first.\n` +
      `  If the hits are in corestore/db/*.sst, the corestore was GRAFTED from an older cut made\n` +
      `  before the hostname neutralization landed: re-cut it fresh (drop --reuse-corestore /\n` +
      `  PAPERCUSP_SEED_REUSE_CORESTORE=never) so every SST is re-stamped with the neutral label.`,
  };
}

/**
 * Enforce the verdict on a staged seed directory. Throws unless clean.
 *
 * Deliberately has NO acknowledgement env, unlike its sibling `assertSeedNotDegraded`: a
 * degraded seed is a big seed, while this one publishes a person's machine, home directory
 * and email to everyone who downloads the app. There is no build worth getting through that
 * badly.
 */
export async function assertStagedSeedCarriesNoIdentity(inp: {
  readonly dir: string;
  readonly neutralHostname: string;
  readonly env?: Record<string, string | undefined>;
  readonly probe?: ResolveIdentityInput['probe'];
}): Promise<SeedIdentityVerdict> {
  const { literals, unknownHostname } = resolveIdentityLiterals({
    env: inp.env,
    neutralHostname: inp.neutralHostname,
    probe: inp.probe,
  });
  if (unknownHostname) {
    throw new Error(
      `[seed-identity] ⛔ cannot prove the staged seed is clean: gethostname() reports the neutral ` +
        `label '${inp.neutralHostname}', so this process is inside the UTS namespace, and ` +
        `${SEED_REAL_HOSTNAME_ENV} was not handed down — the REAL build hostname is unknowable from ` +
        `here. Reporting "clean" would be a statement about the sandbox, not about the seed. Fix the ` +
        `re-exec to export ${SEED_REAL_HOSTNAME_ENV} (seed-hostname-neutralization.ts).`,
    );
  }
  const verdict = await judgeSeedIdentity({ dir: inp.dir, literals });
  if (!verdict.ok) throw new Error(verdict.message);
  console.warn(verdict.message);
  return verdict;
}

/** Exported for the guard's own test: a staged dir must exist before it can be judged. */
export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
