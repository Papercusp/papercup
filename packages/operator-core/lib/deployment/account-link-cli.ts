/**
 * account-link-cli — the WORKING "link a Max account via OAuth" flow
 * (accounts-pool-tab-2026-06-15 P-002 / D-016). It drives the REAL `claude setup-token`
 * CLI in a pty, because claude.ai rejects a hand-built authorize URL clicked in a plain
 * browser — it requires claude-code's own client handshake (see insight
 * claude-oauth-authorize-url; the hand-built authorize-URL approach — formerly
 * account-link-store.ts, since removed as orphaned dead code — was the dead-end it
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
import { readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { registerAccount, normalizeAccountProvider, type AccountProvider } from './account-pool';
import { updateAccountPool, accountStatus, type AccountStatusRow } from './account-pool-store';
import { papercuspPath } from '../papercusp-root';

const ID_RE = /^[A-Za-z0-9._-]+$/;
// Match the authorize URL / the minted token in the CLI's (ANSI-stripped) output.
const URL_RE = /https:\/\/\S*\/oauth\/authorize\?[^\s'"]+/;
const CODEX_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device\b/;
const CODEX_USER_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
const TOKEN_RE = /sk-ant-oat[0-9]*-[A-Za-z0-9_-]+/;
// Settle the code→token step on EITHER the minted token OR a rejection line, so a
// bad/expired code fails fast with claude's own message instead of hanging out the
// full COMPLETE_TIMEOUT_MS. (Rejection shapes seen live: "OAuth error: Request failed
// with status code 400", "Authorization failed", "Invalid …".)
const OUTCOME_RE =
  /sk-ant-oat[0-9]*-[A-Za-z0-9_-]+|OAuth error[^\n]*|Authorization failed[^\n]*|Invalid (?:request|code|authorization)[^\n]*|status code [45]\d\d/i;
const START_TIMEOUT_MS = 30_000; // the CLI to print the URL
const COMPLETE_TIMEOUT_MS = 60_000; // the CLI to mint after we feed the code
const LINK_TTL_MS = 10 * 60 * 1000; // how long a started link waits for the owner's code
// The current `claude setup-token` is an Ink TUI: its masked code input treats a bulk
// `code\r` write as paste text and SWALLOWS the trailing CR, so the code is never
// submitted (the "Linking…" stall). The Enter must be its OWN write, sent AFTER the
// paste settles. Proven against claude CLI v2.1.181.
const SUBMIT_ENTER_DELAY_MS = 300;

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
    const existing = stripAnsi(getBuf()).match(re);
    if (existing) {
      clearTimeout(to);
      resolve(existing[0]);
      return;
    }
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
  provider: AccountProvider;
  configDir: string;
  reaper: ReturnType<typeof setTimeout>;
  /** The deferred Enter-keystroke timer (cleared on cleanup so it can't fire late). */
  enterTimer?: ReturnType<typeof setTimeout>;
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
  if (l.enterTimer) clearTimeout(l.enterTimer);
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
  provider?: AccountProvider;
}
export type StartCliLinkResult =
  | { ok: true; authorizeUrl: string; linkId: string; provider: AccountProvider; userCode?: string }
  | { ok: false; error: string };

/** Spawn the provider CLI and capture the browser-login URL it prints; hold the process. */
export async function startCliLink(input: StartCliLinkInput): Promise<StartCliLinkResult> {
  const accountId = input.accountId?.trim();
  if (!accountId || !ID_RE.test(accountId)) {
    return { ok: false, error: 'accountId required (allowed: A-Za-z0-9 . _ -)' };
  }
  const provider = normalizeAccountProvider(input.provider);
  const configDir = papercuspPath(
    'deploy-credentials',
    provider === 'codex'
      ? `.codex-setup-${accountId}-${randomBytes(4).toString('hex')}`
      : `.setup-${accountId}-${randomBytes(4).toString('hex')}`,
  );
  await mkdir(configDir, { recursive: true });
  let pty: IPty;
  try {
    pty = provider === 'codex'
      ? spawn(process.env.CODEX_BIN || 'codex', ['login', '--device-auth'], {
        name: 'xterm-256color',
        cols: 4000,
        rows: 50,
        cwd: configDir,
        env: { ...process.env, CODEX_HOME: configDir },
      })
      : spawn(process.env.CLAUDE_BIN || 'claude', ['setup-token'], {
      name: 'xterm-256color',
      cols: 4000, // ultra-wide → the long URL + token never wrap (a wrapped line breaks the regex)
      rows: 50,
      cwd: configDir,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    });
  } catch (e) {
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: `couldn't launch the ${providerLabel(provider)} CLI: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
  const linkId = randomUUID();
  const entry: PendingCliLink = {
    pty,
    buf: '',
    accountId,
    label: input.label?.trim() || undefined,
    provider,
    configDir,
    reaper: setTimeout(() => cleanup(linkId), LINK_TTL_MS),
  };
  links.set(linkId, entry);

  const url = await readUntil(pty, () => entry.buf, (d) => {
    entry.buf += d;
  }, provider === 'codex' ? CODEX_URL_RE : URL_RE, START_TIMEOUT_MS);

  if (!url) {
    cleanup(linkId);
    return { ok: false, error: `the ${providerLabel(provider)} CLI did not produce an authorize URL (is \`${provider === 'codex' ? 'codex' : 'claude'}\` installed + on PATH?)` };
  }
  if (provider === 'codex') {
    const userCode = await readUntil(pty, () => entry.buf, (d) => {
      entry.buf += d;
    }, CODEX_USER_CODE_RE, START_TIMEOUT_MS);
    if (!userCode) {
      cleanup(linkId);
      return { ok: false, error: 'the Codex CLI did not produce a device code' };
    }
    return { ok: true, authorizeUrl: url, linkId, provider, userCode };
  }
  return { ok: true, authorizeUrl: url, linkId, provider };
}

export interface CompleteCliLinkInput {
  linkId: string;
  code?: string;
  workspace?: string;
}
export interface CompleteCliLinkDeps {
  notify?: () => void;
  /** Override the post-paste Enter delay (ms). Tests inject a small value. */
  enterDelayMs?: number;
}
export type CompleteCliLinkResult = { ok: true; account: AccountStatusRow | null } | { ok: false; error: string };

function defaultNotify(): void {
  void import('../sync-sse')
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {}))
    .catch(() => {});
}

function providerLabel(provider: AccountProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function extractCodexAccessToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown } };
    return typeof parsed?.tokens?.access_token === 'string' && parsed.tokens.access_token.trim()
      ? parsed.tokens.access_token.trim()
      : null;
  } catch {
    return null;
  }
}

async function completeCodexCliLink(
  linkId: string,
  l: PendingCliLink,
  input: CompleteCliLinkInput,
  deps: CompleteCliLinkDeps,
): Promise<CompleteCliLinkResult> {
  const sourceAuthPath = `${l.configDir}/auth.json`;
  let raw: string;
  try {
    raw = await readFile(sourceAuthPath, 'utf8');
  } catch {
    return { ok: false, error: 'Codex login is not complete yet — enter the device code in the browser, then complete the link' };
  }
  const accessToken = extractCodexAccessToken(raw);
  if (!accessToken) {
    cleanup(linkId);
    return { ok: false, error: 'Codex auth.json did not contain tokens.access_token — restart the add-account flow' };
  }

  try {
    const credPath = papercuspPath('deploy-credentials', `${l.accountId}.codex-auth.json`);
    await mkdir(dirname(credPath), { recursive: true });
    await writeFile(credPath, raw, { mode: 0o600 });
    await chmod(credPath, 0o600);
    const credentialRef = `file:${credPath}`;
    await updateAccountPool((p) => registerAccount(p, { id: l.accountId, provider: 'codex', credentialRef, label: l.label }, Date.now()), input.workspace);
    const account = (await accountStatus(input.workspace)).find((a) => a.id === l.accountId) ?? null;
    cleanup(linkId);
    (deps.notify ?? defaultNotify)();
    return { ok: true, account };
  } catch (e) {
    cleanup(linkId);
    return { ok: false, error: `register failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
}

/** Feed the pasted code into the held CLI when needed, capture the credential, write + register it. */
export async function completeCliLink(input: CompleteCliLinkInput, deps: CompleteCliLinkDeps = {}): Promise<CompleteCliLinkResult> {
  const l = links.get(input.linkId);
  if (!l) return { ok: false, error: 'link expired or unknown — restart the add-account flow' };
  if (l.provider === 'codex') return completeCodexCliLink(input.linkId, l, input, deps);
  const code = input.code?.trim();
  if (!code) return { ok: false, error: 'code required (paste the value claude.ai showed)' };

  l.buf = ''; // capture only post-code output
  // Register the listener, paste the code, THEN press Enter as a SEPARATE write after a
  // short settle (the Ink TUI swallows a CR appended to the paste — see SUBMIT_ENTER_DELAY_MS).
  // Settle on the token OR a rejection line (OUTCOME_RE) so a bad code fails fast.
  const enterDelay = deps.enterDelayMs ?? SUBMIT_ENTER_DELAY_MS;
  const matched = await readUntil(
    l.pty,
    () => l.buf,
    (d) => {
      l.buf += d;
    },
    OUTCOME_RE,
    COMPLETE_TIMEOUT_MS,
    () => {
      l.pty.write(code);
      l.enterTimer = setTimeout(() => {
        try {
          l.pty.write('\r');
        } catch {
          /* pty already gone */
        }
      }, enterDelay);
    },
  );
  const token = matched && TOKEN_RE.test(matched) ? (matched.match(TOKEN_RE)?.[0] ?? null) : null;

  if (!token) {
    const tail = stripAnsi(l.buf).replace(/\s+/g, ' ').trim().slice(-180);
    cleanup(input.linkId);
    const said = tail ? ` — claude said: "${tail}"` : '';
    return {
      ok: false,
      error: matched
        ? `claude rejected the code (it may be expired, already used, or for a different account)${said} — restart the add-account flow`
        : `claude did not return a token${said || ' (the code may be expired/invalid — restart the flow)'}`,
    };
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
