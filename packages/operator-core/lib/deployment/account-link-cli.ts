/**
 * account-link-cli — the WORKING "link a Max account via OAuth" flow
 * (accounts-pool-tab-2026-06-15 P-002 / D-016). It drives the REAL `claude setup-token`
 * CLI in a pty, because claude.ai rejects a hand-built authorize URL clicked in a plain
 * browser — it requires claude-code's own client handshake (see insight
 * claude-oauth-authorize-url; the hand-built account-link-store.ts is the dead-end it
 * replaces). The CLI is the client; we just relay its link + feed the owner's code back.
 *
 * Flow (the button does what an agent used to do by hand):
 *   1. startCliLink → spawn `claude setup-token` in a pty (ISOLATED CLAUDE_CONFIG_DIR so it
 *      never touches this box's ~/.claude), read its output until it prints the authorize
 *      URL, KEEP the process alive keyed by an opaque linkId, return { authorizeUrl, linkId }.
 *   2. The owner opens the URL signed into the TARGET Max account, approves, pastes the
 *      `code#state` claude.ai shows.
 *   3. completeCliLink({ linkId, code }) → write the code into the SAME running CLI, read
 *      until it mints the `sk-ant-oat…` token, write it to ~/.papercusp/deploy-credentials/<id>
 *      (0600) + registerAccount, kill the CLI. The token never reaches the browser.
 *
 * The live pty handles live in an in-memory map (a live process is a resource, not
 * persistable state — the storage-policy "no state Maps" rule is about durable state, not
 * process handles). Pinned on globalThis so both HTTP calls on one operator share it; an
 * idle reaper + a TTL kill any link the owner abandons.
 */
import { spawn, type IPty } from '@lydell/node-pty';
import { writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { registerAccount } from './account-pool';
import { updateAccountPool, accountStatus, type AccountStatusRow } from './account-pool-store';
import { papercuspPath } from '../papercusp-root';

const ID_RE = /^[A-Za-z0-9._-]+$/;
// Match the authorize URL / the minted token in the CLI's (ANSI-stripped) output.
const URL_RE = /https:\/\/\S*\/oauth\/authorize\?[^\s'"]+/;
const TOKEN_RE = /sk-ant-oat[0-9]*-[A-Za-z0-9_-]+/;
const START_TIMEOUT_MS = 30_000; // the CLI to print the URL
const COMPLETE_TIMEOUT_MS = 60_000; // the CLI to mint after we feed the code
const LINK_TTL_MS = 10 * 60 * 1000; // how long a started link waits for the owner's code

function stripAnsi(s: string): string {
  // CSI sequences + OSC sequences — Ink colors its output; the URL/token would otherwise
  // be interrupted mid-string by escape codes and not match.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}

/**
 * Read the pty's (ANSI-stripped, accumulated) output until `re` matches, then resolve with the
 * match — disposing both listeners + the timeout on settle (no leaked handles). `after` runs once
 * the listeners are registered (e.g. write the code only after we're listening for the response).
 */
function readUntil(
  pty: IPty,
  getBuf: () => string,
  appendBuf: (d: string) => void,
  re: RegExp,
  timeoutMs: number,
  after?: () => void,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      od.dispose();
      oe.dispose();
      resolve(v);
    };
    const to = setTimeout(() => finish(null), timeoutMs);
    const od = pty.onData((d) => {
      appendBuf(d);
      const m = stripAnsi(getBuf()).match(re);
      if (m) finish(m[0]);
    });
    const oe = pty.onExit(() => finish(stripAnsi(getBuf()).match(re)?.[0] ?? null));
    after?.();
  });
}

interface PendingCliLink {
  pty: IPty;
  buf: string;
  accountId: string;
  label?: string;
  configDir: string;
  reaper: ReturnType<typeof setTimeout>;
}

type G = typeof globalThis & { __papercuspCliLinks?: Map<string, PendingCliLink> };
const g = globalThis as G;
const links: Map<string, PendingCliLink> = g.__papercuspCliLinks ?? new Map<string, PendingCliLink>();
g.__papercuspCliLinks = links;

function cleanup(linkId: string): void {
  const l = links.get(linkId);
  if (!l) return;
  links.delete(linkId);
  clearTimeout(l.reaper);
  try {
    l.pty.kill();
  } catch {
    /* already exited */
  }
  void rm(l.configDir, { recursive: true, force: true }).catch(() => {});
}

export interface StartCliLinkInput {
  accountId: string;
  label?: string;
}
export type StartCliLinkResult = { ok: true; authorizeUrl: string; linkId: string } | { ok: false; error: string };

/** Spawn `claude setup-token` and capture the authorize URL it prints; hold the process. */
export async function startCliLink(input: StartCliLinkInput): Promise<StartCliLinkResult> {
  const accountId = input.accountId?.trim();
  if (!accountId || !ID_RE.test(accountId)) {
    return { ok: false, error: 'accountId required (allowed: A-Za-z0-9 . _ -)' };
  }
  const configDir = papercuspPath('deploy-credentials', `.setup-${accountId}-${randomBytes(4).toString('hex')}`);
  await mkdir(configDir, { recursive: true });
  let pty: IPty;
  try {
    pty = spawn(process.env.CLAUDE_BIN || 'claude', ['setup-token'], {
      name: 'xterm-256color',
      cols: 4000, // ultra-wide → the long URL + token never wrap (a wrapped line breaks the regex)
      rows: 50,
      cwd: configDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    });
  } catch (e) {
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: `couldn't launch the claude CLI: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
  const linkId = randomUUID();
  const entry: PendingCliLink = {
    pty,
    buf: '',
    accountId,
    label: input.label?.trim() || undefined,
    configDir,
    reaper: setTimeout(() => cleanup(linkId), LINK_TTL_MS),
  };
  links.set(linkId, entry);

  const url = await readUntil(pty, () => entry.buf, (d) => {
    entry.buf += d;
  }, URL_RE, START_TIMEOUT_MS);

  if (!url) {
    cleanup(linkId);
    return { ok: false, error: 'the claude CLI did not produce an authorize URL (is `claude` installed + on PATH?)' };
  }
  return { ok: true, authorizeUrl: url, linkId };
}

export interface CompleteCliLinkInput {
  linkId: string;
  code: string;
  workspace?: string;
}
export interface CompleteCliLinkDeps {
  notify?: () => void;
}
export type CompleteCliLinkResult = { ok: true; account: AccountStatusRow | null } | { ok: false; error: string };

function defaultNotify(): void {
  void import('../sync-sse')
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {}))
    .catch(() => {});
}

/** Feed the pasted code into the held CLI, capture the minted token, write + register it. */
export async function completeCliLink(input: CompleteCliLinkInput, deps: CompleteCliLinkDeps = {}): Promise<CompleteCliLinkResult> {
  const l = links.get(input.linkId);
  if (!l) return { ok: false, error: 'link expired or unknown — restart the add-account flow' };
  const code = input.code?.trim();
  if (!code) return { ok: false, error: 'code required (paste the value claude.ai showed)' };

  l.buf = ''; // capture only post-code output
  // Register the token listener, THEN submit the code (so we never miss the response).
  const token = await readUntil(
    l.pty,
    () => l.buf,
    (d) => {
      l.buf += d;
    },
    TOKEN_RE,
    COMPLETE_TIMEOUT_MS,
    () => l.pty.write(`${code}\r`),
  );

  if (!token) {
    const tail = stripAnsi(l.buf).replace(/\s+/g, ' ').trim().slice(-180);
    cleanup(input.linkId);
    return { ok: false, error: `claude did not return a token${tail ? ` — it said: "${tail}"` : ' (the code may be expired/invalid — restart the flow)'}` };
  }

  try {
    const credPath = papercuspPath('deploy-credentials', l.accountId);
    await mkdir(dirname(credPath), { recursive: true });
    await writeFile(credPath, token, { mode: 0o600 });
    await chmod(credPath, 0o600);
    const credentialRef = `token:${credPath}`;
    await updateAccountPool((p) => registerAccount(p, { id: l.accountId, credentialRef, label: l.label }, Date.now()), input.workspace);
    const account = (await accountStatus(input.workspace)).find((a) => a.id === l.accountId) ?? null;
    cleanup(input.linkId);
    (deps.notify ?? defaultNotify)();
    return { ok: true, account };
  } catch (e) {
    cleanup(input.linkId);
    return { ok: false, error: `register failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
}

/** Test-only: drop all held links (kills the ptys). */
export function __resetCliLinksForTest(): void {
  for (const id of [...links.keys()]) cleanup(id);
}
