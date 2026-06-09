#!/usr/bin/env node
/**
 * PreToolUse guard — keep agents on the Tauri DESKTOP app, not the retired
 * browser webapp.
 *
 * The papercusp operator's Next/Vite/Hono layer on :3055 / :3070 is the
 * DESKTOP's internal content source, not a standalone site. Agents repeatedly
 * try to "see the app" by browsing those ports (verdict / playwright / chrome /
 * a browser-open in bash) instead of launching the Tauri desktop shell. This
 * hook blocks that and redirects. It does NOT block `curl`/API checks (those are
 * allowed while the desktop is up) or any non-operator port.
 *
 * Registered in ~/.claude/settings.json PreToolUse with matcher:
 *   Bash|mcp__playwright__browser_navigate|mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__tabs_create_mcp
 *
 * Exit 0 = allow; exit 2 = block (stderr is shown to the agent).
 *
 * Source of truth: papercup repo CLAUDE.md → "Running / testing this app".
 */
import { readFileSync } from 'node:fs';

const DESKTOP_CMD =
  'cd /home/marsh-office/papercupai-workspace/papercup/papercusp-desktop && npm run dev';

const BLOCK_MSG = [
  '',
  '⛔ BLOCKED — this is the Tauri DESKTOP app, not a browser webapp.',
  '',
  '  Run / test it via the desktop shell:',
  `    ${DESKTOP_CMD}`,
  '  …then drive the Tauri window it opens.',
  '',
  "  Do NOT open :3055 / :3070 in a browser — they are the desktop's internal",
  '  content source (the retired standalone-webapp path), so a browser view is',
  '  broken/misleading. A `curl` to a :3070 API endpoint is fine while the desktop',
  '  is running. See the papercup CLAUDE.md → "Running / testing this app".',
  '',
].join('\n');

const allow = () => process.exit(0);
const block = () => {
  process.stderr.write(BLOCK_MSG + '\n');
  process.exit(2);
};

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow(); // can't parse the hook payload → never block legitimate work
}

const tool = String(payload.tool_name || '');
const input = payload.tool_input || {};

// A localhost/loopback URL on an operator dev port.
const URL_PORTS = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(?:3055|3070)\b/i;

// 1) Browser-navigation MCP tools → block when the target is an operator port.
if (/^mcp__/.test(tool) && /(browser_navigate|navigate|tabs_create_mcp)/i.test(tool)) {
  const url = String(input.url || input.URL || input.uri || '');
  if (URL_PORTS.test(url)) block();
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
  }
  allow();
}

allow();
