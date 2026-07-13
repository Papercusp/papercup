#!/usr/bin/env node
/**
 * check-no-box-identity.mjs — fail-loud guard against a developer's own machine
 * leaking into tracked source (WI-4419).
 *
 * WHY THIS EXISTS
 * Every release bundle ships `sidecar/source.tar.zst`, a tar of the monorepo
 * working tree, straight to whoever we hand a build to. The 0.0.8 cut shipped the
 * owner's home path 53,811 times. bin/audit-release-bundle.py is the GATE that
 * catches that — but it only runs at CUT TIME, on the finished artifact, which is
 * the most expensive possible moment to discover it: the fix is a source change,
 * so the whole build is wasted. This lint catches the same class at EDIT time.
 *
 * Gate vs lint, deliberately different jobs:
 *   - The gate knows THIS box's identity (it resolves the literals at run time) and
 *     is definitive about the artifact we are about to ship.
 *   - This lint cannot know your box's name — and must not, or it would only work
 *     on one machine, which is the bug it is preventing. So it detects the CLASS:
 *     an absolute path into somebody's home directory. That is machine-agnostic:
 *     it fires the same on every contributor's checkout.
 *
 * THE RULE: source must never hardcode `/home/<user>/…` or `/Users/<user>/…`.
 * Derive it instead — `os.homedir()`, `$HOME`, systemd's `%h`, `git rev-parse
 * --show-toplevel`, or a path relative to the file itself. A hardcoded home path is
 * wrong on every machine but one, so this lint is not merely a privacy rail: code it
 * fires on is already broken for everyone else.
 *
 *   node scripts/check-no-box-identity.mjs
 *
 * BASELINE is EMPTY and must stay that way. If this fires, fix the path — do not
 * add an exception to make the build pass.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Home dirs that are NOT a person: shared installs, CI runners, containers. */
const GENERIC_USERS = new Set([
  'linuxbrew', 'dev', 'runner', 'user', 'ubuntu', 'root', 'node', 'builder',
  'vscode', 'codespace', 'shared', 'Shared', 'ci', 'agent',
  // Service/VM accounts that belong to the PRODUCT, not to a person: the account
  // inside a deployed frame, the WSL distro, the Windows VM's stock account, and
  // the placeholder a doc/test uses on purpose. Naming these is not a leak.
  // Keep this list to non-personal accounts only — it is not a place to silence
  // a real name to make the build pass.
  'pcusp', 'papercusp', 'papercup', 'tester', 'User', 'x',
]);
/** Anonymous by construction: a redaction (`/home/.../`, `/home/<user>/`) or a
 *  1–2 char stand-in a test/doc uses precisely because it names nobody. */
const isRedacted = (user) =>
  /^[.<{$%]/.test(user) || user === '$USER' || user === 'USER' || user.length <= 2;

/** Not shipped / not source / regenerated. The dirs the release gate already strips
 *  from the bundle (.harness, .tmp, .papercusp, agent-briefs, docs/plans, junit.xml)
 *  are skipped here too, so the lint and the gate agree on what "shipped" means. */
const SKIP = [
  /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)dist(-\w+)?\//, /(^|\/)build\//,
  /(^|\/)coverage\//, /(^|\/)_retired\//, /(^|\/)\.papercusp\//, /(^|\/)docs\.old\.\d+\//,
  /(^|\/)agent-briefs\//, /^docs\/plans\//, /(^|\/)public\/internal\/docs\//,
  /(^|\/)\.harness\//, /(^|\/)\.tmp(-[^/]*)?\//, /(^|\/)\.claude\//,
  /(^|\/)__pycache__\//, /\.pyc$/,
  /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|zst|gz|tgz|zip|pdf|mp[34]|wav|lock)$/i,
  /(^|\/)package-lock\.json$/, /(^|\/)junit\.xml$/,
  // Root-level agent handoff/brief notes: internal coordination, not in the bundle's
  // top-level allowlist (stage-source-tree.sh), so they never reach a user.
  /^(HANDOFF|BRIEF|FLEET|SELF-BRIEF|LIVE)-.*\.md$/,
];

const HOME_PATH = /\/(home|Users)\/([A-Za-z0-9._-]+)(?=[/'"`\s\\)\]:,;]|$)/g;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\n')
  .filter((f) => f && !SKIP.some((rx) => rx.test(f)));

const findings = [];
for (const f of files) {
  let src;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue; // binary / unreadable
  }
  if (!src.includes('/home/') && !src.includes('/Users/')) continue;
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(HOME_PATH)) {
      const user = m[2];
      if (GENERIC_USERS.has(user) || isRedacted(user)) continue;
      findings.push({ file: f, line: i + 1, user, text: line.trim().slice(0, 110) });
    }
  });
}

if (findings.length === 0) {
  console.log(`✓ no box-identity paths in ${files.length} tracked source files`);
  process.exit(0);
}

console.error(`\n✗ ${findings.length} hardcoded home path(s) in tracked source.\n`);
console.error('  These name ONE developer\'s machine. They are wrong on every other');
console.error('  checkout, and they ship to users inside the release source drop.\n');
for (const f of findings.slice(0, 40)) {
  console.error(`  ${f.file}:${f.line}  (user "${f.user}")`);
  console.error(`      ${f.text}`);
}
if (findings.length > 40) console.error(`  … and ${findings.length - 40} more`);
console.error('\n  FIX by deriving the path, not by adding an exception:');
console.error('    node/ts   os.homedir()  ·  path relative to import.meta.url / __dirname');
console.error('    shell     "$HOME"  ·  git -C "$(dirname "$0")" rev-parse --show-toplevel');
console.error('    systemd   %h');
console.error('    config    a machine-local ~/.papercusp/*.env, read at run time\n');
process.exit(1);
