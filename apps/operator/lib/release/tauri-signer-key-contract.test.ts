/**
 * tauri-signer-key-contract.test — EI-20549708598153511.
 *
 * `tauri build` accepts EITHER the updater key's CONTENT or a PATH in
 * TAURI_SIGNING_PRIVATE_KEY. `tauri signer sign` accepts ONLY the content. Every
 * conventional caller in this repo legitimately exports the PATH — release-local.sh:988,
 * build-linux-local.sh:98, build-and-archive-deb.sh:63 — so any `tauri signer sign` call
 * site that just inherits the ambient env is handed a pathname and dies with:
 *
 *   failed to decode base64 secret key: failed to decode base64 key: Invalid symbol 45, offset N
 *
 * (symbol 45 is '-', N lands on the first '-' of the key's own pathname.)
 *
 * This is not hypothetical and it is not new. build-appimage.sh:519-531 already carries a
 * long comment documenting the trap and derefs path->content before its own signer call
 * (WI-3823). repack-deb-xz.sh then added a SECOND signer call site in 2026-08-14 without
 * the deref, and it killed the 0.0.17-alpha cut — after a full cargo compile and two
 * signed multi-GB debs, roughly 35 minutes in. Because release-local.sh's join_leg() does
 * a hard `exit 1` on any leg's nonzero rc and the legs run in PARALLEL, that one line
 * also reaped the still-running Windows and macOS legs. (Since EI-20549139616021387 the
 * legs are supervised concurrently and healthy siblings are SALVAGED rather than reaped —
 * but the cut still fails outright, so a signer defect still costs the whole release.)
 *
 * So the property worth pinning is not "repack-deb-xz.sh is fixed" — that is a single
 * commit and a test asserting it would go stale the moment the file is refactored. It is
 * the CLASS: *no* signer call site anywhere in papercusp-desktop/bin may depend on the
 * ambient TAURI_SIGNING_PRIVATE_KEY being content rather than a path. A third call site
 * is the thing that must fail here, and it is exactly what a reviewer will not notice,
 * because the broken form looks like the obvious way to write it.
 *
 * A call site is compliant one of two ways, both of which are in the tree today:
 *   1. `--private-key-path "$KEY_FILE"`   — that flag is defined to take a path
 *      (build-windows-cross.sh:388, build-mac-cross.sh:377), or
 *   2. resolve a path to its contents first, then hand the secret to the CLI via its OWN
 *      env fallback (build-appimage.sh:531, repack-deb-xz.sh). Never on argv: npx/npm
 *      echo the fully resolved command line, which would print the private key into the
 *      build log and expose it in `ps` for the life of the process.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SIGNER_INVOCATION = 'tauri signer sign';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'release-local.sh'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate a repo root containing papercusp-desktop/bin/release-local.sh');
}

/**
 * Join backslash-continued shell lines into logical commands, dropping comments.
 * Both compliant forms in the tree spread the env prefix and the `tauri signer sign`
 * words across several physical lines, so a per-physical-line scan would see a bare
 * `tauri signer sign "$OUT"` and report every call site as unsafe.
 */
export function toLogicalCommands(script: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = script.split('\n');
  let buf = '';
  let startLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (buf === '' && raw.trimStart().startsWith('#')) continue; // prose mentions the trap by name
    if (buf === '') startLine = i + 1;
    const continued = /\\\s*$/.test(raw);
    buf += (buf === '' ? '' : ' ') + raw.replace(/\\\s*$/, '').trim();
    if (!continued) {
      if (buf.includes(SIGNER_INVOCATION)) out.push({ line: startLine, text: buf });
      buf = '';
    }
  }
  if (buf.includes(SIGNER_INVOCATION)) out.push({ line: startLine, text: buf });
  return out;
}

/**
 * A signer call is safe iff it passes --private-key-path, or it sets
 * TAURI_SIGNING_PRIVATE_KEY from a variable the script already resolved from a path to
 * its contents. The deref must be PRESENT IN THE SAME SCRIPT — passing along a variable
 * someone else populated is precisely the ambient-inheritance assumption that broke.
 */
export function findUnsafeSignerCalls(script: string): { line: number; text: string; why: string }[] {
  const unsafe: { line: number; text: string; why: string }[] = [];
  for (const cmd of toLogicalCommands(script)) {
    if (cmd.text.includes('--private-key-path')) continue;

    const envAssign = /TAURI_SIGNING_PRIVATE_KEY="\$(\w+)"/.exec(cmd.text);
    if (!envAssign) {
      unsafe.push({
        line: cmd.line,
        text: cmd.text,
        why: 'inherits ambient TAURI_SIGNING_PRIVATE_KEY, which callers set to a PATH',
      });
      continue;
    }
    const name = envAssign[1];
    const deref = new RegExp(
      `\\[\\[?\\s*-f\\s+"\\$${name}"\\s*\\]\\]?\\s*&&\\s*${name}="\\$\\(cat\\s+"\\$${name}"\\)"`,
    );
    if (!deref.test(script)) {
      unsafe.push({
        line: cmd.line,
        text: cmd.text,
        why: `passes $${name} but never resolves a path to its contents`,
      });
    }
  }
  return unsafe;
}

/**
 * ── Second contract, same variable: NEVER CLOBBER A CALLER-SUPPLIED KEY.
 *
 * Filed with the bug above as its "latent sibling", and it is the reason that cut could
 * not be rescued from the outside: release-local.sh hardcoded KEY_FILE from $HOME and
 * then `export TAURI_SIGNING_PRIVATE_KEY="$KEY_FILE"` UNCONDITIONALLY, as did
 * build-linux-local.sh — so an operator who supplied a working key in the environment had
 * it silently overwritten by the conventional path, and the only way forward was to
 * advance the pinned tree. build-and-archive-deb.sh:55-67 was already right and is the
 * shape both now copy; its own FATAL even advises "provide TAURI_SIGNING_PRIVATE_KEY
 * directly", advice that was inert on the one script that drives a real cut.
 *
 * An assignment is compliant three ways:
 *   1. inside an `if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]` region,
 *   2. self-defaulting — `"${TAURI_SIGNING_PRIVATE_KEY:-$KEY_FILE}"`, or
 *   3. a per-command prefix whose value the script DERIVED from the ambient one (the
 *      path->content deref that the first contract above requires).
 *
 * SCOPE (deliberate): lines carrying an escaped `\$` are skipped — those are the body of a
 * script being GENERATED for another host (mac-vm-verify-build.sh:155 writes a remote
 * build script over ssh), where pinning the remote's own key file is the intent, not a
 * clobber of this process's environment.
 */
const CLOBBER_GUARD = /^if\b.*-z\s+"\$\{TAURI_SIGNING_PRIVATE_KEY:-\}"/;
const KEY_ASSIGN = /(^|[^_A-Za-z0-9])TAURI_SIGNING_PRIVATE_KEY=("[^"]*"|\S+)/;

export function findClobberingKeyAssignments(
  script: string,
): { line: number; text: string; why: string }[] {
  const out: { line: number; text: string; why: string }[] = [];
  const lines = script.split('\n');
  let depth = 0;
  const guardDepths: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (text.startsWith('#') || text === '') continue;
    if (/^if\b/.test(text)) {
      depth += 1;
      if (CLOBBER_GUARD.test(text)) guardDepths.push(depth);
    }
    const m = KEY_ASSIGN.exec(text);
    if (m && !text.includes('\\$')) {
      const rhs = m[2];
      const guarded = guardDepths.length > 0;
      const selfDefaulting = rhs.includes('${TAURI_SIGNING_PRIVATE_KEY');
      const fromVar = /^"\$(\w+)"$/.exec(rhs);
      const derefed =
        fromVar !== null &&
        new RegExp(
          `\\[\\[?\\s*-f\\s+"\\$${fromVar[1]}"\\s*\\]\\]?\\s*&&\\s*${fromVar[1]}="\\$\\(cat\\s+"\\$${fromVar[1]}"\\)"`,
        ).test(script);
      if (!guarded && !selfDefaulting && !derefed) {
        out.push({
          line: i + 1,
          text,
          why: 'unconditionally overwrites a caller-supplied TAURI_SIGNING_PRIVATE_KEY',
        });
      }
    }
    if (/^fi\b/.test(text) || /;\s*fi$/.test(text)) {
      if (guardDepths[guardDepths.length - 1] === depth) guardDepths.pop();
      depth -= 1;
    }
  }
  return out;
}

const root = repoRoot();
// Overridable so falsifiability can also be proven against a MUTATED COPY outside the
// tree (scripts/mutation-probe.sh, tier 2) rather than by mutating the shared checkout,
// which git-sync can commit mid-probe.
const binDir = process.env.PROBE_DESKTOP_BIN ?? join(root, 'papercusp-desktop/bin');

// ── Permanently-embedded controls (tier 1). These are deliberately-wrong and
// deliberately-right implementations kept in the test file forever, so the scanner's
// falsifiability is proven on every run and never has to be re-argued.
const CONTROL_BROKEN = `
if [[ -n "\${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  npx --yes -p "@tauri-apps/cli@2.11.0" \\
    tauri signer sign "$REPLACEMENT" >/dev/null
fi
`;
const CONTROL_DEREF = `
_key="$TAURI_SIGNING_PRIVATE_KEY"; [ -f "$_key" ] && _key="$(cat "$_key")"
if TAURI_SIGNING_PRIVATE_KEY="$_key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \\
      npx --yes -p @tauri-apps/cli@"$V" tauri signer sign "$OUT"; then
  echo ok
fi
`;
const CONTROL_KEY_PATH = `
npx --yes -p @tauri-apps/cli@"$V" tauri signer sign --private-key-path "$KEY_FILE" --password "$P" "$SETUP_EXE"
`;
// The env var is passed along but never resolved from a path — the subtle form, and the
// one a reviewer is most likely to wave through.
const CONTROL_PASSTHROUGH = `
TAURI_SIGNING_PRIVATE_KEY="$_key" \\
  npx --yes -p @tauri-apps/cli@"$V" tauri signer sign "$OUT"
`;

describe('tauri signer key contract', () => {
  // CALIBRATION. Every "zero violations" assertion below is vacuous if the scanner has
  // stopped finding call sites at all — a rename of the invocation, a move of the bin
  // directory, or a continuation-joining bug would each turn this suite green while
  // measuring nothing. Anchor the population first.
  it('still finds the signer call sites it is meant to police', () => {
    const scripts = readdirSync(binDir).filter((f) => f.endsWith('.sh'));
    const withCalls = scripts.filter((f) =>
      toLogicalCommands(readFileSync(join(binDir, f), 'utf8')).length > 0,
    );
    expect(withCalls.length).toBeGreaterThanOrEqual(4);
    expect(withCalls).toEqual(
      expect.arrayContaining([
        'build-appimage.sh',
        'build-mac-cross.sh',
        'build-windows-cross.sh',
        'repack-deb-xz.sh',
      ]),
    );
  });

  it('flags a call site that inherits the ambient key (the 0.0.17 regression)', () => {
    const found = findUnsafeSignerCalls(CONTROL_BROKEN);
    expect(found).toHaveLength(1);
    expect(found[0].why).toMatch(/ambient/);
  });

  it('flags a call site that forwards the key without ever resolving a path', () => {
    expect(findUnsafeSignerCalls(CONTROL_PASSTHROUGH)).toHaveLength(1);
  });

  it('accepts both compliant forms', () => {
    expect(findUnsafeSignerCalls(CONTROL_DEREF)).toEqual([]);
    expect(findUnsafeSignerCalls(CONTROL_KEY_PATH)).toEqual([]);
  });

  // ── Controls for the clobber scanner. CONTROL_CLOBBER_AFTER_FI is the one that
  // matters most: without it, a tracker that opened the guard and never closed it would
  // report every later assignment as safe and this whole contract would measure nothing.
  const CONTROL_CLOBBER = `
KEY_FILE="$HOME/.papercusp/signing/papercusp.key"
export TAURI_SIGNING_PRIVATE_KEY="$KEY_FILE"
`;
  const CONTROL_GUARDED = `
if [[ -z "\${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$KEY_FILE"
else
  echo "==> updater signing key: supplied via TAURI_SIGNING_PRIVATE_KEY"
fi
`;
  const CONTROL_DEFAULTED = `
(cd "$ROOT" && TAURI_SIGNING_PRIVATE_KEY="\${TAURI_SIGNING_PRIVATE_KEY:-$KEY_FILE}" bash bin/build-appimage.sh)
`;
  const CONTROL_CLOBBER_AFTER_FI = `
if [[ -z "\${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$KEY_FILE"
fi
export TAURI_SIGNING_PRIVATE_KEY="$OTHER_KEY"
`;

  it('flags an unconditional export that overwrites a caller-supplied key', () => {
    const found = findClobberingKeyAssignments(CONTROL_CLOBBER);
    expect(found).toHaveLength(1);
    expect(found[0].why).toMatch(/unconditionally/);
  });

  it('closes the guard region at `fi` (a later clobber is still caught)', () => {
    const found = findClobberingKeyAssignments(CONTROL_CLOBBER_AFTER_FI);
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain('$OTHER_KEY');
  });

  it('accepts the guarded, self-defaulting and derived forms', () => {
    expect(findClobberingKeyAssignments(CONTROL_GUARDED)).toEqual([]);
    expect(findClobberingKeyAssignments(CONTROL_DEFAULTED)).toEqual([]);
    expect(findClobberingKeyAssignments(CONTROL_DEREF)).toEqual([]);
  });

  // CALIBRATION for the clobber scan, same reason as above: if the scanner stops seeing
  // assignments at all (a rename, a move), "zero violations" is vacuous.
  it('still finds the key assignments it is meant to police', () => {
    const withAssignments = readdirSync(binDir)
      .filter((f) => f.endsWith('.sh'))
      .filter((f) => KEY_ASSIGN.test(readFileSync(join(binDir, f), 'utf8')));
    expect(withAssignments.length).toBeGreaterThanOrEqual(4);
    expect(withAssignments).toEqual(
      expect.arrayContaining(['release-local.sh', 'build-linux-local.sh', 'build-and-archive-deb.sh']),
    );
  });

  it('no script in papercusp-desktop/bin clobbers a caller-supplied signing key', () => {
    const violations: string[] = [];
    for (const file of readdirSync(binDir).filter((f) => f.endsWith('.sh'))) {
      for (const v of findClobberingKeyAssignments(readFileSync(join(binDir, file), 'utf8'))) {
        violations.push(`${file}:${v.line} — ${v.why}\n    ${v.text.slice(0, 160)}`);
      }
    }
    expect(
      violations,
      `A caller-supplied TAURI_SIGNING_PRIVATE_KEY (key CONTENT or a path) must win.\n` +
        `Guard the assignment instead:\n` +
        `  if [[ -z "\${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then export TAURI_SIGNING_PRIVATE_KEY="$KEY_FILE"; fi\n` +
        `or default from it: TAURI_SIGNING_PRIVATE_KEY="\${TAURI_SIGNING_PRIVATE_KEY:-$KEY_FILE}"\n\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('no script in papercusp-desktop/bin hands the signer a key path', () => {
    const violations: string[] = [];
    for (const file of readdirSync(binDir).filter((f) => f.endsWith('.sh'))) {
      for (const v of findUnsafeSignerCalls(readFileSync(join(binDir, file), 'utf8'))) {
        violations.push(`${file}:${v.line} — ${v.why}\n    ${v.text.slice(0, 160)}`);
      }
    }
    expect(
      violations,
      `\`tauri signer sign\` must receive the key CONTENT, not a path.\n` +
        `Fix by either passing --private-key-path, or dereferencing first:\n` +
        `  _key="$TAURI_SIGNING_PRIVATE_KEY"; [[ -f "$_key" ]] && _key="$(cat "$_key")"\n` +
        `then invoking with TAURI_SIGNING_PRIVATE_KEY="$_key" (via env, never on argv —\n` +
        `npx echoes the resolved command line and would leak the key to the log and ps).\n\n` +
        violations.join('\n'),
    ).toEqual([]);
  });
});
