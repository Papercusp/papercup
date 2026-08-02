/**
 * Guard: the wake-word model must never be fetched from the public internet.
 *
 * cdn-egress-fixes-2026-08-02 P-003, and the third sibling of monaco-cdn.test.ts
 * and vditor-cdn.test.ts next door — same class of bug, same shape of guard.
 *
 * `PorcupineWorker.create()` takes a `publicPath` for its ~961KB model. We used
 * to pass
 * `https://raw.githubusercontent.com/Picovoice/porcupine/master/lib/common/porcupine_params.pv`,
 * which is wrong three separate ways: it is a runtime fetch of a megabyte from a
 * SOURCE host (rate-limited, not a CDN, no availability promise), it rides a
 * MOVING ref (`master`), and the model is now vendored at setup time by
 * apps/operator/scripts/setup-porcupine-runtime.sh instead.
 *
 * THE FAILURE MODE THIS GUARDS is unusually inviting. `publicPath` accepts a URL
 * quite happily, and when the model 404s the symptom is that wake-word silently
 * stops working — no crash, no console error a reviewer would notice. The
 * obvious "fix" for someone who has not read this plan is to paste the upstream
 * URL back in, because it visibly works on their machine. Nothing in the build
 * would object. That is exactly why this has to be a source-level assertion
 * rather than something we hope to catch in review.
 *
 * WHY THE CHECKSUM IS ASSERTED HERE TOO. Pinning by commit sha is only half the
 * pin: a vendored binary can be replaced in the tree by a bad merge, a partial
 * download, or a well-meaning "refresh". Size is NOT an identity check for this
 * file — the v3.0 tag serves a DIFFERENT model of exactly the same byte length
 * as v4.0/master, so only the checksum distinguishes them.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripJsComments } from './strip-js-comments';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');

const ENGINE = resolve(REPO_ROOT, 'packages/operator-core/lib/voice-engines/porcupine.ts');
const SETUP_SCRIPT = resolve(REPO_ROOT, 'apps/operator/scripts/setup-porcupine-runtime.sh');
const VENDORED_MODEL = resolve(REPO_ROOT, 'apps/operator/public/porcupine/porcupine_params.pv');

/**
 * Drop comments before pattern-matching. Load-bearing, not tidiness: the module
 * under test DOCUMENTS the old upstream URL in its own header prose (and so does
 * this file), so a naive match reports the very thing the fix removed. Same
 * lesson the two sibling guards learned; same shared single-pass scanner.
 */
const stripComments = stripJsComments;

/** Any fetchable remote origin — not just the one host we happened to use. */
const REMOTE_URL = /https?:\/\//;

describe('porcupine cdn (cdn-egress-fixes-2026-08-02 P-003)', () => {
  it('the model path is a local absolute path, not a remote URL', async () => {
    const src = await readFile(ENGINE, 'utf8');
    const path = src.match(/export const PORCUPINE_MODEL_PATH = '([^']+)'/)?.[1];

    expect(path, 'PORCUPINE_MODEL_PATH must exist and be a single-quoted literal').toBeTruthy();
    expect(path!.startsWith('/'), `expected a local absolute path, got ${path}`).toBe(true);
    expect(REMOTE_URL.test(path!), `PORCUPINE_MODEL_PATH must not be a URL, got ${path}`).toBe(false);
  });

  it('the engine contains no remote URL in live code', async () => {
    const code = stripComments(await readFile(ENGINE, 'utf8'));
    const offenders = code.match(/https?:\/\/[^\s'"`)]+/g) ?? [];

    // Named, not counted: a bare "expected 1 to be 0" makes the next person
    // re-derive which URL crept back in.
    expect(offenders, `remote URL(s) in porcupine engine code: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every PorcupineWorker.create passes the local model path', async () => {
    const code = stripComments(await readFile(ENGINE, 'utf8'));

    const creates = code.match(/PorcupineWorker\.create\(/g) ?? [];
    const publicPaths = code.match(/publicPath:\s*PORCUPINE_MODEL_PATH\b/g) ?? [];

    expect(creates.length).toBeGreaterThanOrEqual(1);
    expect(
      publicPaths.length,
      'every PorcupineWorker.create must pass publicPath: PORCUPINE_MODEL_PATH',
    ).toBe(creates.length);
  });

  it('the vendored model is pinned by an immutable commit sha, never a moving ref', async () => {
    const sh = await readFile(SETUP_SCRIPT, 'utf8');
    const ref = sh.match(/^PORCUPINE_REF="([^"]+)"/m)?.[1];

    expect(ref, 'PORCUPINE_REF must be set').toBeTruthy();
    // A 40-hex commit sha. `master`, `main`, or a tag are all mutable — a tag can
    // be force-moved, and that is the whole reason this is pinned by sha.
    expect(ref!, `PORCUPINE_REF must be a 40-hex commit sha, got "${ref}"`).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the vendored model on disk matches the pinned checksum', async () => {
    const sh = await readFile(SETUP_SCRIPT, 'utf8');
    const pinned = sh.match(/^PORCUPINE_SHA256="([0-9a-f]{64})"/m)?.[1];
    expect(pinned, 'PORCUPINE_SHA256 must be set to a 64-hex digest').toBeTruthy();

    const bytes = await readFile(VENDORED_MODEL);
    const actual = createHash('sha256').update(bytes).digest('hex');

    expect(
      actual,
      `vendored model at ${VENDORED_MODEL} does not match the pinned sha256 — ` +
        'the file was replaced, truncated, or refreshed off a different ref',
    ).toBe(pinned);
  });

  it('the setup script verifies the checksum before installing', async () => {
    const sh = await readFile(SETUP_SCRIPT, 'utf8');
    // Downloading and hoping is the failure this prevents: a truncated or
    // rate-limit-HTML response would otherwise be installed as "the model".
    expect(sh).toMatch(/sha256sum/);
    expect(sh).toMatch(/PORCUPINE_SHA256/);
  });
});
