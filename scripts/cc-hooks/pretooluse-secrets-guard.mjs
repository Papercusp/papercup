#!/usr/bin/env node
// scripts/cc-hooks/pretooluse-secrets-guard.mjs
//
// PreToolUse (Edit|Write|MultiEdit) BLOCKING secrets guard — su-papercusp-way-gate-2026-07-06 P-006.
//
// WHY
//   The persona's credentials row routes agents ("setup:save_key for the 4 platform provider
//   keys; ANY other secret: never into a tree file") — but a prompt is a route, not a wall.
//   A key written into a git-sync-owned shared tree is auto-committed within minutes and
//   then lives in history. This hook is the hard backstop: it DENIES the write BEFORE the
//   key-shaped string reaches a shared-tree file.
//
// CONTRACT
//   - Scope: writes whose file_path is inside a shared git-sync tree (built-in:
//     ~/papercupai-workspace/ and ~/.papercusp-workspaces/clones/; override via
//     PAPERCUSP_SECRETS_GUARD_TREES, ':'-separated prefixes). Everything else exits 0.
//   - Allowlist: PAPERCUSP_SECRETS_GUARD_ALLOW (':'-separated path substrings) for
//     legitimate secrets paths — empty by default; prefer keeping secrets OUT of trees
//     over allowlisting.
//   - On a key-shaped hit: permissionDecision "deny" (JSON, exit 0) with a reason that
//     names the papercusp way. The matched token is MASKED in the reason (never echoed).
//   - Placeholder-shaped matches (xxx / example / YOUR / redacted / ...) are exempt.
//   - FAIL-OPEN on internal errors: a bug here must never wedge every edit. The deny on a
//     genuine match is the point and is not an error path.
//   - Known limitation (by design, recorded in the plan): Bash heredoc/redirect writes are
//     not covered — this hook pairs with the persona row, it does not replace review.
//   - `--self-test` runs the embedded cases (no stdin needed) and exits non-zero on failure.
//
import process from 'node:process';

const HOME = process.env.HOME || '/home/marsh-office';
const DEFAULT_TREES = [`${HOME}/papercupai-workspace/`, `${HOME}/.papercusp-workspaces/clones/`];

const PATTERNS = [
  { name: 'OpenAI/Anthropic-style key (sk-…)', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub classic PAT (ghp_…)', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: 'GitHub fine-grained PAT (github_pat_…)', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: 'GitHub app token (gho_/ghu_/ghs_/ghr_…)', re: /\bgh[ousr]_[A-Za-z0-9]{36}\b/g },
  { name: 'AWS access key id (AKIA…)', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'PEM private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

// A match that is visibly a placeholder is not a secret.
const PLACEHOLDER = /xxx|\.\.\.|<|example|placeholder|your[-_]|redacted|1234567890/i;

main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    const input = hook.tool_input || {};
    const filePath = input.file_path || '';
    if (!inSharedTree(filePath) || isAllowlisted(filePath)) return done();

    const content = extractContent(tool, input);
    if (!content) return done();

    const hit = findSecret(content);
    if (hit) return deny(filePath, hit);
  } catch {
    // fail-open: never wedge edits on a hook bug
  }
  done();
}

function inSharedTree(filePath) {
  if (!filePath) return false;
  const trees = (process.env.PAPERCUSP_SECRETS_GUARD_TREES || '').split(':').filter(Boolean);
  return (trees.length ? trees : DEFAULT_TREES).some((t) => filePath.startsWith(t));
}

function isAllowlisted(filePath) {
  const allow = (process.env.PAPERCUSP_SECRETS_GUARD_ALLOW || '').split(':').filter(Boolean);
  return allow.some((a) => filePath.includes(a));
}

function extractContent(tool, input) {
  if (tool === 'Write') return input.content || '';
  if (tool === 'Edit') return input.new_string || '';
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((e) => e && e.new_string).filter(Boolean).join('\n');
  }
  return '';
}

function findSecret(content) {
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) {
      if (PLACEHOLDER.test(m[0])) continue;
      const line = content.slice(0, m.index).split('\n').length;
      return { name, masked: m[0].slice(0, 8) + '…(' + m[0].length + ' chars)', line };
    }
  }
  return null;
}

function deny(filePath, hit) {
  const base = filePath.split(/[/\\]/).pop();
  const reason =
    `🛑 secrets-guard (P-006): ${hit.name} detected at line ${hit.line} of the content being ` +
    `written to ${base} — a shared git-sync tree file (auto-committed to history within minutes). ` +
    `Matched token: ${hit.masked}. The papercusp way: a platform provider key ` +
    `(openai/anthropic/zeroentropy/github_pat) goes to setup:save_key; ANY other secret goes in ` +
    `injected config OUTSIDE the repo — never a tree file. If this file is a legitimate secrets ` +
    `path, the owner can allowlist it via PAPERCUSP_SECRETS_GUARD_ALLOW.`;
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }) + '\n',
    );
    process.stderr.write(reason + '\n');
  } catch {
    /* ignore */
  }
  process.exit(0);
}

function done() {
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

// ─── self-test ─────────────────────────────────────────────────────────

function selfTest() {
  const TREE = `${HOME}/papercupai-workspace/papercup/some/file.ts`;
  const OUT = `/tmp/scratch/notes.md`;
  const FAKE_SK = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
  const FAKE_GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const FAKE_AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const cases = [
    { name: 'real-shaped sk- key in tree file → DENY', path: TREE, content: `const k = "${FAKE_SK}";`, expectDeny: true },
    { name: 'ghp_ token in tree file → DENY', path: TREE, content: `token: ${FAKE_GHP}`, expectDeny: true },
    { name: 'AKIA id in tree file → DENY', path: TREE, content: `aws_access_key_id=${FAKE_AKIA}`, expectDeny: true },
    { name: 'PEM header in tree file → DENY', path: TREE, content: '-----BEGIN RSA PRIVATE KEY-----', expectDeny: true },
    { name: 'placeholder sk-xxx… → allow', path: TREE, content: 'use sk-xxxxxxxxxxxxxxxxxxxxxxxx here', expectDeny: false },
    { name: 'placeholder sk-your-key → allow', path: TREE, content: 'sk-your-key-goes-here-ok-now', expectDeny: false },
    { name: 'real-shaped key OUTSIDE trees → allow', path: OUT, content: `const k = "${FAKE_SK}";`, expectDeny: false },
    { name: 'prose mentioning sk- prefix only → allow', path: TREE, content: 'keys start with sk- and ghp_ prefixes', expectDeny: false },
  ];
  let failed = 0;
  for (const c of cases) {
    const denied = !!(inSharedTree(c.path) && !isAllowlisted(c.path) && findSecret(c.content));
    const ok = denied === c.expectDeny;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  }
  console.log(failed ? `${failed} case(s) FAILED` : 'all cases passed');
  process.exit(failed ? 1 : 0);
}
