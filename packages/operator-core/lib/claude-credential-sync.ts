/**
 * claude-credential-sync.ts — newest-wins reconciliation of the Claude OAuth
 * credential bundle across the user-global `~/.claude/.credentials.json` and
 * every per-session `CLAUDE_CONFIG_DIR` fork under `~/.papercusp/session-claude/`
 * (claude-credential-sync-2026-06-10 P-001).
 *
 * WHY THIS EXISTS. The interactive per-session `CLAUDE_CONFIG_DIR` mirror
 * (interactive-claude-config.ts, EI-153/EI-155) symlinks `.credentials.json`
 * back to `~/.claude` so an OAuth refresh "passes through". In practice claude
 * rewrites the file by REPLACING it (write-temp + rename), which swaps the
 * symlink for a divergent real-file fork. Anthropic refresh tokens are
 * single-use and rotate: once one fork refreshes, every other copy (including
 * the global file) holds a consumed refresh token, fails its next refresh, and
 * forces `/login` — and refresh-token REUSE can revoke the whole token family
 * (upstream anthropics/claude-code#48786, #54443). On a box running a fleet of
 * sessions this cascades into "every terminal demands its own login" and 401s
 * for every headless spawn (memory: claude-p-headless-never-refreshes-oauth).
 *
 * THE FIX. Treat all copies as ONE logical credential: whenever any copy gets a
 * newer `claudeAiOauth` bundle (later `expiresAt`), propagate that bundle to
 * the global file and every real-file fork. Convergence makes the forks
 * harmless — by the time any session needs its token it already holds the
 * newest family member. Symlinked entries are skipped (they resolve to the
 * global file, which is reconciled directly).
 *
 * Safety properties:
 *  - ONLY the `claudeAiOauth` member is propagated — `mcpOAuth` (per-session
 *    MCP server tokens) and any other top-level keys stay per-file.
 *  - A bundle must look like a live rotating-family member to win: `sk-ant-`
 *    accessToken, a refreshToken (a `claude setup-token` bundle has none and
 *    must never clobber the interactive family), a finite `expiresAt` within
 *    a 30-day plausibility cap (garbage/forged-future guard).
 *  - Writes are atomic (same-dir temp + rename, 0600) and strictly monotonic
 *    (target updated only when its bundle is strictly older), so a converged
 *    tree produces zero writes — the fs.watch feedback loop terminates.
 *  - Nothing is ever deleted and absence is never propagated: a `/logout` in
 *    one session stays local to that session.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { homedir } from 'node:os';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { dirname, join } from 'node:path';
import { sessionClaudeRoot } from '@papercusp/orchestrator/session-launch-dirs';

/** Upper bound on a plausible interactive-OAuth `expiresAt` distance: real
 *  access tokens live ~8h; anything claiming >30d out is garbage or forged. */
const MAX_PLAUSIBLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The interactive Claude OAuth bundle inside `.credentials.json`. */
interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  [k: string]: unknown;
}

interface Candidate {
  path: string;
  /** Parsed full-file JSON (base for the merge-write); `{}` if unreadable. */
  json: Record<string, unknown>;
  /** The valid bundle, or null (missing / malformed / implausible). */
  bundle: ClaudeAiOauth | null;
  isGlobal: boolean;
}

export interface ReconcileResult {
  /** Real credential files examined (symlink aliases excluded). */
  scanned: number;
  /** Paths whose bundle was replaced by the winner this pass. */
  updated: string[];
  /** Winner provenance, or null when no valid bundle exists anywhere. */
  winner: { path: string; expiresAt: number } | null;
}

export interface ReconcileOptions {
  /** Source HOME (testability); defaults to the process home. */
  home?: string;
  /** Session-config root (testability); defaults to `sessionClaudeRoot()`. */
  sessionRoot?: string;
  /** Clock override (testability). */
  now?: number;
}

function globalCredentialsPath(home: string): string {
  return join(home, '.claude', '.credentials.json');
}

function parseBundle(json: Record<string, unknown>, now: number): ClaudeAiOauth | null {
  const o = json.claudeAiOauth;
  if (!o || typeof o !== 'object') return null;
  const b = o as Record<string, unknown>;
  if (typeof b.accessToken !== 'string' || !b.accessToken.startsWith('sk-ant-')) return null;
  if (typeof b.refreshToken !== 'string' || b.refreshToken.length === 0) return null;
  if (typeof b.expiresAt !== 'number' || !Number.isFinite(b.expiresAt)) return null;
  if (b.expiresAt > now + MAX_PLAUSIBLE_TTL_MS) return null;
  return b as unknown as ClaudeAiOauth;
}

/** Read a REAL credentials file (caller has excluded symlinks). Unreadable /
 *  unparseable content yields `json: {}` — a later merge-write heals it. */
function readCandidate(path: string, isGlobal: boolean, now: number): Candidate {
  let json: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed;
  } catch {
    /* corrupt or vanished mid-read — treat as empty base */
  }
  return { path, json, bundle: parseBundle(json, now), isGlobal };
}

/** True when the path exists and is NOT a symlink (a fork worth reconciling).
 *  Symlinks resolve to the global file and are reconciled through it. */
function isRealFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function writeBundle(target: Candidate, bundle: ClaudeAiOauth): void {
  const merged = { ...target.json, claudeAiOauth: bundle };
  const tmp = join(
    dirname(target.path),
    `.credentials.json.credsync-${process.pid}-${Math.floor(Math.random() * 1e9)}`,
  );
  writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  renameSync(tmp, target.path);
}

/**
 * One reconcile pass. Synchronous on purpose: the interactive launcher
 * (`writeInteractiveClaudeConfig`) calls it inline before mirroring so a new
 * session seeds from the newest bundle, and the watcher calls it on debounce.
 * Scans ≲ a few hundred small files — milliseconds.
 */
export function reconcileClaudeCredentials(opts: ReconcileOptions = {}): ReconcileResult {
  const home = opts.home ?? homedir();
  const sessionRoot = opts.sessionRoot ?? sessionClaudeRoot();
  const now = opts.now ?? Date.now();

  const candidates: Candidate[] = [];
  const globalPath = globalCredentialsPath(home);
  if (isRealFile(globalPath)) candidates.push(readCandidate(globalPath, true, now));

  let sessionDirs: string[] = [];
  try {
    sessionDirs = readdirSync(sessionRoot);
  } catch {
    /* no session root yet */
  }
  for (const dir of sessionDirs) {
    const p = join(sessionRoot, dir, '.credentials.json');
    if (isRealFile(p)) candidates.push(readCandidate(p, false, now));
  }

  // Winner: newest expiresAt; ties prefer global, then lexicographic path —
  // deterministic, and a tie with the global file means "no churn".
  let winner: Candidate | null = null;
  for (const c of candidates) {
    if (!c.bundle) continue;
    if (
      !winner ||
      c.bundle.expiresAt > winner.bundle!.expiresAt ||
      (c.bundle.expiresAt === winner.bundle!.expiresAt &&
        (c.isGlobal || (!winner.isGlobal && c.path < winner.path)))
    ) {
      winner = c;
    }
  }
  if (!winner) return { scanned: candidates.length, updated: [], winner: null };

  const updated: string[] = [];
  const winningBundle = winner.bundle!;

  // Restore a missing global file from the freshest fork (the documented
  // recovery for "global broke for every headless spawn") — but only when
  // ~/.claude exists; never materialize a .claude dir on a box without one.
  if (!isRealFile(globalPath) && !existsSync(globalPath) && existsSync(dirname(globalPath))) {
    candidates.push({ path: globalPath, json: {}, bundle: null, isGlobal: true });
  }

  for (const c of candidates) {
    if (c === winner) continue;
    if (c.bundle && c.bundle.expiresAt >= winningBundle.expiresAt) continue;
    try {
      writeBundle(c, winningBundle);
      updated.push(c.path);
    } catch (e) {
      console.warn(
        `[claude-cred-sync]   ! ${c.path}: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  return {
    scanned: candidates.length,
    updated,
    winner: { path: winner.path, expiresAt: winningBundle.expiresAt },
  };
}

const GUARD_KEY = '__papercuspClaudeCredentialSync';
const DEBOUNCE_MS = 1_500;
const FALLBACK_INTERVAL_MS = 5 * 60 * 1000;

export interface CredentialSyncHandle {
  stop(): void;
}

/**
 * Start the background sync: an initial reconcile, fs.watch on the global
 * `~/.claude` dir + the session-claude root (recursive — Linux-supported), a
 * debounce so claude's own temp+rename bursts coalesce into one pass, and a
 * 5-minute interval fallback for missed events. Idempotent per process.
 *
 * `isEnabled` is consulted per PASS (not at start), so a feature-flag flip
 * takes effect without an operator restart.
 */
export function startClaudeCredentialSync(opts: {
  home?: string;
  sessionRoot?: string;
  /** Per-pass gate (feature flag). Defaults to always-on. */
  isEnabled?: () => Promise<boolean> | boolean;
} = {}): CredentialSyncHandle {
  const g = globalThis as Record<string, unknown>;
  if (g[GUARD_KEY]) return g[GUARD_KEY] as CredentialSyncHandle;

  const home = opts.home ?? homedir();
  const sessionRoot = opts.sessionRoot ?? sessionClaudeRoot();
  const isEnabled = opts.isEnabled ?? (() => true);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const pass = async (trigger: string) => {
    if (stopped) return;
    try {
      if (!(await isEnabled())) return;
      const r = reconcileClaudeCredentials({ home, sessionRoot });
      if (r.updated.length > 0 && r.winner) {
        console.log(
          `[claude-cred-sync] ${trigger}: winner=${r.winner.path} ` +
            `exp=${new Date(r.winner.expiresAt).toISOString()} → updated ${r.updated.length} file(s)`,
        );
      }
    } catch (e) {
      console.warn(`[claude-cred-sync] pass failed: ${(e as Error)?.message ?? e}`);
    }
  };

  const kick = (trigger: string) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void pass(trigger), DEBOUNCE_MS);
    debounce.unref?.();
  };

  const watchers: FSWatcher[] = [];
  try {
    watchers.push(
      watch(join(home, '.claude'), { persistent: false }, (_ev, file) => {
        if (file === '.credentials.json') kick('watch:global');
      }),
    );
  } catch (e) {
    console.warn(`[claude-cred-sync] global watch unavailable: ${(e as Error)?.message ?? e}`);
  }
  try {
    mkdirSync(sessionRoot, { recursive: true });
    watchers.push(
      watch(sessionRoot, { persistent: false, recursive: true }, (_ev, file) => {
        if (file && file.endsWith('.credentials.json')) kick('watch:session');
      }),
    );
  } catch (e) {
    console.warn(`[claude-cred-sync] session watch unavailable: ${(e as Error)?.message ?? e}`);
  }

  const interval = managedSetInterval('claude-credential-sync', FALLBACK_INTERVAL_MS, () => pass('interval'), {
    category: 'watchdog',
  });
  void pass('boot');

  const handle: CredentialSyncHandle = {
    stop() {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      interval.stop();
      for (const w of watchers) w.close();
      delete g[GUARD_KEY];
    },
  };
  g[GUARD_KEY] = handle;
  return handle;
}
