#!/usr/bin/env node
/**
 * PreToolUse guard — keep agents on the Tauri DESKTOP app, not the retired
 * browser webapp.
 *
 * The papercusp operator's Next/Vite/Hono layer on :3055 / :3070 / :3170 is
 * the DESKTOP's internal content source, not a standalone site. Agents
 * repeatedly try to "see the app" by browsing those ports (verdict /
 * playwright / chrome / a browser-open in bash) instead of launching the
 * Tauri desktop shell. This hook blocks that and redirects. It does NOT block
 * `curl`/API checks (those are allowed while the desktop is up) or any
 * non-operator port.
 *
 * Registered in ~/.claude/settings.json PreToolUse with matcher:
 *   mcp__playwright__browser_navigate|mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__tabs_create_mcp|Skill
 * (Bash is deliberately NOT matched — see the branch-2 comment below: a
 * text-scanning Bash matcher would false-positive on anything that merely
 * MENTIONS these ports, e.g. a commit message, a grep, editing this file.)
 * Wired via mergeClaudeHookSettings (packages/operator-core/lib/desktop-
 * install/papercusp-files.ts) + the install-standalone-mcp.sh sibling
 * (merge_guard_operator_desktop_hook) — KEEP THE TWO IN SYNC (EI-16981: this
 * hook previously lived at repo-root scripts/cc-hooks/ and was NEVER wired
 * into either installer, so the block/redirect it documents never fired).
 *
 * Exit 0 = allow; exit 2 = block (stderr is shown to the agent).
 *
 * EI-13177: :3170 (the STAGING operator — same Hono/SPA host as :3070, per
 * the repo's two-port model) was missing from the port list, so an agent
 * pointing verdict/playwright at it got NO redirect and hit the exact
 * silent-hang symptom this guard exists to prevent (curl 200, but browser
 * navigation never reaches DOMContentLoaded — the SPA expects the Tauri
 * IPC bridge this raw browser view never provides). Added.
 *
 * Source of truth: papercup repo CLAUDE.md → "Running / testing this app".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The desktop dir of THE CHECKOUT THIS HOOK LIVES IN — not one box's path. */
function desktopDir() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  try {
    const root = execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    return join(root, 'papercusp-desktop');
  } catch {
    return join(here, '..', '..', 'papercusp-desktop');
  }
}

const DESKTOP_CMD = `cd ${desktopDir()} && npm run dev`;

const BLOCK_MSG = [
  '',
  '⛔ BLOCKED — this is the Tauri DESKTOP app, not a browser webapp.',
  '',
  '  Run / test it via the desktop shell:',
  `    ${DESKTOP_CMD}`,
  '  …then drive the Tauri window it opens.',
  '',
  "  Do NOT open :3055 / :3070 / :3170 in a browser — they are the desktop's",
  "  internal content source (the retired standalone-webapp path), so a browser",
  '  view is broken/misleading. A `curl` to a :3070/:3170 API endpoint is fine',
  '  while the desktop is running. See the papercup CLAUDE.md → "Running / testing',
  '  this app".',
  '',
].join('\n');

const allow = () => process.exit(0);
const block = (msg = BLOCK_MSG) => {
  process.stderr.write(msg + '\n');
  process.exit(2);
};

/* ── Loopback-deception guard (EI-20732462499061834) ───────────────────────
 * A REMOTE-looking hostname that resolves to LOOPBACK is the dangerous case,
 * and it is the opposite failure from the one above: there, a browser view of
 * an operator port is visibly broken. Here the check SUCCEEDS — whatever is
 * listening locally answers 200 with a well-formed body and there is no tell
 * in the response, so a "prod" verification silently reports on localhost.
 *
 * Measured on this box: `/etc/hosts` pins `sidestage.papercusp.com` to
 * 127.0.0.1, so `https://sidestage.papercusp.com/` returned 200 from
 * ip=127.0.0.1 in 0.3s while the real origin was unreachable. The filer had
 * already cited a sha read that way as prod evidence in two work-items.
 *
 * We block only the DECEPTIVE case — a name that looks remote but resolves
 * loopback. Navigating to `localhost` / `127.0.0.1` / `*.local` is a
 * deliberate local check and stays allowed. Every failure path here allows:
 * a guard that blocks on its own resolver error is worse than the bug.
 */
const LOOPBACK_ADDR = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|0:0:0:0:0:0:0:1)$/;

/** Names that are SUPPOSED to resolve locally — pointing at them is intentional. */
function isExplicitlyLocal(host) {
  return (
    !host ||
    /^localhost$/i.test(host) ||
    /\.localhost$/i.test(host) ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /\.local$/i.test(host)
  );
}

/** Resolve via the SAME path the tools use (nsswitch → /etc/hosts, then DNS). */
function resolvesToLoopback(host) {
  let out;
  try {
    out = execFileSync('getent', ['hosts', host], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return false; // no such host, getent missing, or timeout → fail OPEN
  }
  const addrs = out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
  // ALL addresses loopback ⇒ every connection to this name lands locally.
  return addrs.length > 0 && addrs.every((a) => LOOPBACK_ADDR.test(a));
}

const loopbackMsg = (host, url) =>
  [
    '',
    `⛔ BLOCKED — "${host}" resolves to LOOPBACK on this box.`,
    '',
    `  ${url}`,
    '',
    '  This looks like a remote/prod check but it would hit whatever is',
    '  listening on THIS machine. The local server answers 200 with a',
    '  well-formed body and there is NO tell in the response — so the run',
    '  would pass and you would report localhost as prod.',
    '',
    `  Confirm the pin:   getent hosts ${host}`,
    '  (/etc/hosts on this box deliberately pins some *.papercusp.com names;',
    '   see the comment on the flags.papercuspai.com line before changing any.)',
    '',
    '  To verify a REMOTE host, run the probe ON that host (ssh/docker exec)',
    '  rather than from here — the office LAN also drops TLS handshakes whose',
    '  SNI is *.papercusp.com, so --resolve to the origin IP times out too.',
    '  If you meant to check LOCAL behaviour, say so and target localhost',
    '  explicitly — then the evidence reads "localhost", which is honest.',
    '',
  ].join('\n');

/** Pull candidate URLs out of a raw string (a verdict args blob, etc.). */
function urlsIn(text) {
  return String(text).match(/https?:\/\/[^\s"'<>\\)]+/gi) ?? [];
}

/** Block if any URL in `text` names a remote host that resolves to loopback. */
function checkLoopbackDeception(text) {
  for (const url of urlsIn(text)) {
    let host;
    try {
      host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    } catch {
      continue;
    }
    if (isExplicitlyLocal(host)) continue;
    if (resolvesToLoopback(host)) block(loopbackMsg(host, url));
  }
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow(); // can't parse the hook payload → never block legitimate work
}

const tool = String(payload.tool_name || '');
const input = payload.tool_input || {};

// A localhost/loopback URL on an operator dev port. EI-13177: 3170 (staging
// operator) added — same desktop-internal content source as 3070, just the
// staging checkout; it was silently missing from this list.
const URL_PORTS = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(?:3055|3070|3170)\b/i;

// 1) Browser-navigation MCP tools → block when the target is an operator port.
if (/^mcp__/.test(tool) && /(browser_navigate|navigate|tabs_create_mcp)/i.test(tool)) {
  const url = String(input.url || input.URL || input.uri || '');
  if (URL_PORTS.test(url)) block();
  checkLoopbackDeception(url);
  allow();
}

// 2) verdict skill (the mandated browser tool) pointed at the operator ports.
//    Scoped to skill === 'verdict' so it can't false-positive on unrelated work.
//    NOTE: Bash is deliberately NOT matched — text-scanning bash commands blocks
//    anything that merely MENTIONS the ports (commit messages, greps, editing
//    these docs). The loud CLAUDE.md directive covers the rare `chromium :3055`
//    bash case; this hook only blocks the unambiguous browser-navigation vectors.
if (tool === 'Skill') {
  const skill = String(input.skill || input.name || '');
  if (/verdict/i.test(skill)) {
    const args = JSON.stringify(input.args ?? input.arguments ?? input ?? '');
    if (URL_PORTS.test(args)) block();
    checkLoopbackDeception(args);
  }
  allow();
}

allow();
