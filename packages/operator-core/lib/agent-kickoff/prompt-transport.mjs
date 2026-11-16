import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createControlPlaneTempDirWithFile } from '../control-plane-temp.mjs';

// Free-form first-turn transport only; managed session-port files keep their
// separate authority/hash protocol. Share this plain ESM seam with the Node PSU.
export const KICKOFF_PROMPT_FILE_ENV = 'PAPERCUSP_KICKOFF_PROMPT_FILE';
export const INLINE_KICKOFF_MAX_BYTES = 16 * 1024;
// The Node host and operator parent share one private receipt protocol.
export const KICKOFF_PROOF_PATH_ENV = 'PAPERCUSP_KICKOFF_PROOF_PATH';
export const KICKOFF_PROOF_TOKEN_ENV = 'PAPERCUSP_KICKOFF_PROOF_TOKEN';
const KICKOFF_PROOF_TOKEN_RE = /^[a-f0-9]{48}$/i;

/**
 * Publish the parent-visible proof for a plain launch kickoff.
 *
 * The parent creates an empty 0600 file before detaching the child and passes
 * its path plus a random token through the existing PAPERCUSP_* environment
 * chain. Treat both values as untrusted at this boundary: only replace an
 * absolute, same-UID, regular 0600 empty placeholder, and never follow a
 * symlink. The receipt is written to a unique same-directory 0600 temporary
 * file, fsynced, and atomically renamed over that exact placeholder. A failed
 * publication is returned as a negative result so a receipt problem can never
 * tear down an otherwise usable host.
 *
 * @param {{persisted?: boolean, nativeRef?: string | null, reason?: string | null}} proof
 * @param {Record<string, string | undefined>} [env]
 * @returns {{published: boolean, reason?: string, errorMessage?: string, errorCode?: string | null}}
 */
export function publishKickoffProofReceipt(proof, env = process.env) {
  const rawPath = env?.[KICKOFF_PROOF_PATH_ENV];
  const rawToken = env?.[KICKOFF_PROOF_TOKEN_ENV];
  if (rawPath == null && rawToken == null) {
    return { published: false, reason: 'kickoff-proof-request-missing' };
  }
  if (typeof rawPath !== 'string' || typeof rawToken !== 'string') {
    return { published: false, reason: 'kickoff-proof-request-malformed' };
  }
  const path = rawPath;
  const token = rawToken;
  if (!isAbsolute(path) || path.includes(String.fromCharCode(0))) {
    return { published: false, reason: 'kickoff-proof-path-invalid' };
  }
  if (!KICKOFF_PROOF_TOKEN_RE.test(token)) {
    return { published: false, reason: 'kickoff-proof-token-invalid' };
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const assertPlaceholder = () => {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('kickoff-proof placeholder is not a regular file');
    }
    if ((before.mode & 0o777) !== 0o600 || before.size !== 0) {
      throw new Error('kickoff-proof placeholder is not an empty 0600 file');
    }
    if (currentUid == null || before.uid !== currentUid) {
      throw new Error('kickoff-proof placeholder is not owned by this parent uid');
    }
    const fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.size !== 0 ||
        opened.uid !== currentUid
      ) {
        throw new Error('kickoff-proof placeholder changed during secure open');
      }
      return { dev: opened.dev, ino: opened.ino };
    } finally {
      closeSync(fd);
    }
  };

  let tempPath = null;
  let tempFd = null;
  try {
    const original = assertPlaceholder();
    const persisted = proof?.persisted === true;
    const nativeRef = typeof proof?.nativeRef === 'string' ? proof.nativeRef : null;
    const reason =
      typeof proof?.reason === 'string'
        ? proof.reason
        : persisted
          ? null
          : 'native-turn-marker-timeout';
    const receipt = JSON.stringify({ token, persisted, nativeRef, reason });
    const dir = dirname(path);
    const base = path.slice(path.lastIndexOf('/') + 1);
    tempPath = join(
      dir,
      '.' + base + '.tmp-' + process.pid + '-' + randomBytes(12).toString('hex'),
    );
    tempFd = openSync(
      tempPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(tempFd, receipt, { encoding: 'utf8' });
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;
    chmodSync(tempPath, 0o600);

    // Re-check the inode after the potentially slow receipt write. This closes
    // the ordinary replacement race; rename itself never follows a symlink.
    const stillPlaceholder = assertPlaceholder();
    if (stillPlaceholder.dev !== original.dev || stillPlaceholder.ino !== original.ino) {
      throw new Error('kickoff-proof placeholder changed before atomic publish');
    }
    renameSync(tempPath, path);
    tempPath = null;
    return { published: true };
  } catch (error) {
    return {
      published: false,
      reason: 'kickoff-proof-receipt-publish-failed',
      errorMessage: String(error?.message ?? error).slice(0, 500),
      errorCode: typeof error?.code === 'string' ? error.code : null,
    };
  } finally {
    if (tempFd != null) {
      try { closeSync(tempFd); } catch { /* best-effort */ }
    }
    if (tempPath) {
      try { unlinkSync(tempPath); } catch { /* best-effort */ }
    }
  }
}

const PREFIX = 'papercusp-kickoff-transport-';
const FILENAME = 'prompt.txt';
const CLEANUP_MS = 10 * 60 * 1000;
const cleanupTimers = new Map();

/** Keep large prompts out of both the shell argv and its inherited environment. */
export function prepareKickoffEnvironment(env) {
  const text = env?.PAPERCUSP_KICKOFF_PROMPT;
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') <= INLINE_KICKOFF_MAX_BYTES) return env;
  const directory = realpathSync(createControlPlaneTempDirWithFile(PREFIX, FILENAME, text, 'payload'));
  const path = join(directory, FILENAME);
  try {
    chmodSync(directory, 0o700);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  // The consumer removes it immediately. Bound debris from a launch that never
  // reaches PSU without racing the launcher's admission/boot window.
  const timer = setTimeout(() => {
    cleanupTimers.delete(directory);
    try { rmSync(directory, { recursive: true, force: true }); }
    catch (error) { console.warn('kickoff transport cleanup failed:', error); }
  }, CLEANUP_MS);
  timer.unref?.();
  cleanupTimers.set(directory, timer);
  const next = { ...env, [KICKOFF_PROMPT_FILE_ENV]: path };
  delete next.PAPERCUSP_KICKOFF_PROMPT;
  return next;
}

/** Consume only our private regular-file envelope; a missing file fails loudly. */
export function consumeKickoffPromptFile(path) {
  if (typeof path !== 'string' || !path) return null;
  const absolute = resolve(path);
  const directory = dirname(absolute);
  const file = lstatSync(absolute);
  const parent = lstatSync(directory);
  if (basename(absolute) !== FILENAME || !basename(directory).startsWith(PREFIX) ||
      file.isSymbolicLink() || !file.isFile() || parent.isSymbolicLink() || !parent.isDirectory() ||
      realpathSync(absolute) !== absolute || (file.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && (file.uid !== process.getuid() || parent.uid !== process.getuid()))) {
    throw new Error('Invalid private kickoff prompt transport file');
  }
  const text = readFileSync(absolute, 'utf8');
  const cleanupTimer = cleanupTimers.get(directory);
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimers.delete(directory);
  }
  rmSync(directory, { recursive: true, force: true });
  return text;
}
