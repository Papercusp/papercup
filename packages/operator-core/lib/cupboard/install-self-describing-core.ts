/**
 * install-self-describing-core — the ONE generic "install a self-describing dir
 * from a Cupboard mirror repo into a writable user layer" core
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-004, D-003).
 *
 * WHY THIS EXISTS
 * ---------------
 * `install-template-core.ts` already implemented this shape, but hard-wired to
 * templates in exactly four places: the manifest filename it requires
 * (`template.yaml`), the reader it parses with (`readTemplateDir`), the user layer
 * it writes into (`userTemplatesDir`), and its error/label strings. Everything
 * else — the GitHub-URL guard, the safe-ref guard, the clone-to-tmp, the
 * `<clone>/<ref>/` location, the path-escape assertion, the .git-excluding copy,
 * the guaranteed tmp cleanup — is kind-agnostic.
 *
 * Adding `rubric` and `recipe` listings (each ALSO a self-describing dir in a
 * mirror repo, installed into its own writable user layer) would have meant
 * copying those ~100 lines twice, including the two SECURITY guards
 * (`assertInside` path-escape and `SAFE_REF_RE`) — the exact duplication where a
 * later fix lands in one copy and silently misses the others.
 *
 * This is the WRITE-half sibling of `self-describing-store.ts`, which already
 * shares the READ half across the template and rubric stores on the same
 * reasoning (its header records that as the Q2 consult outcome: "share the read
 * half, keep the write halves separate" — that ruling was about the SEED vs
 * OVERLAY write paths, which genuinely differ, not about this clone-and-place
 * path, which does not).
 *
 * The core stays dependency-injected (clone / user dir / tmp dir) so it is
 * unit-testable without real git, network, or the host filesystem layout.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

// A mirror-repo clone target. Mirrors install-blueprint-core / install-template-core.
const GITHUB_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;
// A ref becomes BOTH a directory name under the user layer AND a within-repo path
// segment, so it must be a safe SINGLE segment. UNTRUSTED (from the listing/caller).
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;

export class InstallSelfDescribingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'InstallSelfDescribingError';
  }
}

/** What makes one installable KIND different from another. Everything a caller
 *  must supply to turn the generic core into a concrete installer. */
export interface SelfDescribingKindSpec<TMeta> {
  /** Human label used in error messages ('template', 'rubric', 'recipe'). */
  label: string;
  /** The manifest file that MUST be present for the dir to be that kind
   *  ('template.yaml', 'rubric.json', 'recipe.json'). Checked before anything
   *  lands in the user store, so a wrong-kind subdir 422s rather than installing. */
  manifestFile: string;
  /** Parse the source dir with the SAME reader the store enumeration uses, so the
   *  metadata reported here matches what the corresponding `*:list` will show once
   *  installed. Return null ⇒ the dir does not parse (422). */
  readDir: (dir: string, ref: string) => TMeta | null;
  /** Absolute path of the writable user layer for this kind. */
  userDir: () => string;
}

export interface InstallSelfDescribingInput {
  /** The mirror repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo discriminator — REQUIRED (content always lives in a per-ref subdir). */
  listingRef: string;
  /** Optional source-qualified local directory name. The source is still read
   * from listingRef; this only changes the user-layer destination. */
  targetRef?: string;
  /** Explicit update path. Default installs remain create-only. */
  replaceExisting?: boolean;
}

export interface InstallSelfDescribingDeps {
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
}

export interface InstallSelfDescribingResult<TMeta> {
  ok: true;
  /** The installed ref (its user-layer subdir name). */
  ref: string;
  /** Whatever the kind's own reader produced — the caller shapes its response from this. */
  meta: TMeta;
  /** The clone source (the mirror repo URL). */
  source: string;
  installedTo: string;
}

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new InstallSelfDescribingError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/**
 * Locate `<cloneDir>/<ref>/`, hard-422ing a missing subdir and re-guarding the ref
 * against path escape (belt-and-braces: the ref already passed SAFE_REF_RE, but this
 * dir is attacker-influenced content and the check is nearly free).
 */
function locateRefDir(cloneDir: string, ref: string, label: string): string {
  const dir = join(cloneDir, ref);
  assertInside(cloneDir, dir, `${label} ref "${ref}"`);
  if (!existsSync(dir)) {
    throw new InstallSelfDescribingError(`"${ref}/" not found in the mirror repo`, 422);
  }
  return dir;
}

/** Recursively copy a content dir into a new `target`, excluding any .git. */
async function copyContentDir(src: string, target: string): Promise<void> {
  await fs.cp(src, target, {
    recursive: true,
    // The caller rejects an existing target before reaching this helper. Keep the
    // copy itself create-only too, so a target that appears between that check and
    // fs.cp cannot be overwritten by a concurrent install.
    force: false,
    errorOnExist: true,
    filter: (s) => !s.split(/[/\\]/).includes('.git'),
  });
}

/**
 * Clone a Cupboard mirror repo, validate `<clone>/<ref>/` is a self-describing dir
 * of the given kind, and place it in that kind's writable user layer.
 *
 * Ordering is deliberate and load-bearing: BOTH validations (manifest present, and
 * the dir parses with the kind's own reader) run BEFORE the create-only
 * `copyContentDir`, so a bad publish can never clobber an already-installed good
 * ref of the same name. Existing refs are a conflict; an explicit update path must
 * be separate from this install path. The tmp clone is removed in `finally` on every
 * path.
 */
export async function installSelfDescribingFromCupboard<TMeta>(
  input: InstallSelfDescribingInput,
  spec: SelfDescribingKindSpec<TMeta>,
  deps: InstallSelfDescribingDeps,
): Promise<InstallSelfDescribingResult<TMeta>> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new InstallSelfDescribingError(
      `invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`,
      400,
    );
  }
  const ref = (input.listingRef ?? '').trim();
  if (!SAFE_REF_RE.test(ref)) {
    throw new InstallSelfDescribingError(
      `unsafe ${spec.label} ref ${JSON.stringify(input.listingRef)}`,
      400,
    );
  }
  const targetRef = (input.targetRef ?? ref).trim();
  if (!SAFE_REF_RE.test(targetRef)) {
    throw new InstallSelfDescribingError(
      `unsafe local ${spec.label} ref ${JSON.stringify(input.targetRef)}`,
      400,
    );
  }

  const cloneDir = join(
    deps.tmpDir(),
    `cupboard-${spec.label}-install-${process.pid}-${randomUUID()}`,
  );
  try {
    await deps.cloneRepo(url, cloneDir);
    const srcDir = locateRefDir(cloneDir, ref, spec.label);

    if (!existsSync(join(srcDir, spec.manifestFile))) {
      throw new InstallSelfDescribingError(
        `"${ref}/" in the mirror repo is not a ${spec.label} dir (no ${spec.manifestFile})`,
        422,
      );
    }
    const meta = spec.readDir(srcDir, targetRef);
    if (!meta) {
      throw new InstallSelfDescribingError(
        `${spec.label} "${ref}" failed to parse its ${spec.manifestFile}`,
        422,
      );
    }

    const userDir = spec.userDir();
    const target = join(userDir, targetRef);
    assertInside(userDir, target, `${spec.label} ref "${targetRef}"`);
    const targetExists = existsSync(target);
    if (targetExists && input.replaceExisting !== true) {
      throw new InstallSelfDescribingError(
        `${spec.label} "${targetRef}" is already installed at ${target}; refusing to overwrite`,
        409,
      );
    }
    await fs.mkdir(userDir, { recursive: true });
    if (!targetExists) {
      await copyContentDir(srcDir, target);
    } else {
      const suffix = `${process.pid}-${randomUUID()}`;
      const incoming = `${target}.incoming-${suffix}`;
      const backup = `${target}.backup-${suffix}`;
      try {
        await copyContentDir(srcDir, incoming);
        await fs.rename(target, backup);
        try {
          await fs.rename(incoming, target);
        } catch (error) {
          await fs.rename(backup, target).catch(() => {});
          throw error;
        }
        await fs.rm(backup, { recursive: true, force: true });
      } finally {
        await fs.rm(incoming, { recursive: true, force: true }).catch(() => {});
        if (!existsSync(target) && existsSync(backup)) {
          await fs.rename(backup, target).catch(() => {});
        }
      }
    }

    return { ok: true, ref: targetRef, meta, source: url, installedTo: target };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
