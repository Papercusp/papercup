/**
 * worker-plugin.test.ts — shape-validation for the `papercusp-worker` Claude plugin
 * manifest (papercusp-worker-integration-2026-06-04, D-005, progressive packaging).
 *
 * This validates the manifest is schema-correct (valid JSON, required fields, the
 * hooks wire the worker scripts incl. the activity bridge). It does NOT exercise a
 * live `claude plugin install` — that, plus portable Cupboard distribution (D-008),
 * is the remaining distribution work documented in the bundle README.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));

describe('papercusp-worker plugin manifest', () => {
  it('has the required Claude plugin fields (kebab-case name + version + description)', () => {
    expect(manifest.name).toBe('papercusp-worker');
    expect(manifest.name).toMatch(/^[a-z][a-z0-9-]*$/); // kebab-case identifier
    expect(typeof manifest.version).toBe('string');
    expect(typeof manifest.description).toBe('string');
  });

  it('declares its hooks via the ./hooks/hooks.json component path', () => {
    expect(manifest.hooks).toBe('./hooks/hooks.json');
  });

  it('does NOT declare a statusLine (Claude statuslines are user-settings only, not a plugin contribution)', () => {
    expect(manifest.statusLine).toBeUndefined();
  });
});

function commands(section: Array<{ hooks: Array<{ command: string }> }> | undefined): string[] {
  return (section ?? []).flatMap((e) => e.hooks.map((h) => h.command));
}

describe('papercusp-worker hooks.json', () => {
  it('wires the lock + coord + activity-bridge PostToolUse hooks', () => {
    const post = commands(hooks.hooks.PostToolUse);
    expect(post.some((c) => c.includes('posttooluse-locks-release.sh'))).toBe(true);
    expect(post.some((c) => c.includes('posttooluse-coord-inbox.sh'))).toBe(true);
    // The headline: the cross-CLI activity bridge.
    expect(post.some((c) => c.includes('posttooluse-activity-report.sh'))).toBe(true);
  });

  it('wires the lock-acquire + bash-gate PreToolUse hooks', () => {
    const pre = commands(hooks.hooks.PreToolUse);
    expect(pre.some((c) => c.includes('pretooluse-locks-acquire.sh'))).toBe(true);
    expect(pre.some((c) => c.includes('pretooluse-bash-resource-gate.sh'))).toBe(true);
  });

  it('the activity hook fires on EVERY tool (matcher "*")', () => {
    const activityEntry = (hooks.hooks.PostToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>)
      .find((e) => e.hooks.some((h) => h.command.includes('posttooluse-activity-report.sh')));
    expect(activityEntry?.matcher).toBe('*');
  });

  it('references the stable installed hook location (operator-dependent, fails open without it), except the rtk hook (a system binary, host-guarded on its own)', () => {
    const all = [...commands(hooks.hooks.PreToolUse), ...commands(hooks.hooks.PostToolUse)];
    expect(all.every((c) => c.includes('/.papercusp/hooks/cc/') || c.includes('rtk hook claude'))).toBe(true);
  });

  // WI-3164: surface-B rtk fleet rollout — the rtk PreToolUse rewrite hook.
  it('wires the rtk hook AFTER the bash-resource-gate in the SAME Bash matcher entry (deny wins)', () => {
    const bashEntry = (hooks.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>).find(
      (e) => e.matcher === 'Bash',
    );
    expect(bashEntry).toBeDefined();
    const cmds = bashEntry!.hooks.map((h) => h.command);
    const gateIdx = cmds.findIndex((c) => c.includes('pretooluse-bash-resource-gate.sh'));
    const rtkIdx = cmds.findIndex((c) => c.includes('rtk hook claude'));
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(rtkIdx).toBeGreaterThan(gateIdx);
  });

  it('host-guards the rtk hook so a host without rtk installed degrades silently (no hard failure)', () => {
    const bashEntry = (hooks.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>).find(
      (e) => e.matcher === 'Bash',
    );
    const rtkCmd = bashEntry!.hooks.map((h) => h.command).find((c) => c.includes('rtk hook claude'));
    expect(rtkCmd).toBeDefined();
    // Must probe for the binary before invoking it, and exit clean (0) when absent.
    expect(rtkCmd).toMatch(/command -v rtk/);
    expect(rtkCmd).toMatch(/\|\|\s*exit 0/);
  });
});

/**
 * EI-9471 regression: the rtk PreToolUse rewrite hook hijacked a scoped single-file
 * `npx vitest run <file> | grep | head` into a FULL-SUITE run (10k suites, 11MB) when
 * rtk's vitest output-parser failed on the piped/compound form — it dropped the file
 * filter and re-synthesized an UNSCOPED run. Fix: our fleet rtk hook now SKIPS vitest
 * commands entirely (fail-open — skip = run verbatim, never a deny), so rtk's buggy
 * vitest parser can never touch a vitest command. We execute the ACTUAL shipped hook
 * command string against a hermetic fake `rtk` and assert vitest never reaches it while
 * a non-vitest command still does. Fails BEFORE the fix (rtk was invoked for vitest).
 */
describe('papercusp-worker rtk hook — vitest skip (EI-9471)', () => {
  const rtkCommand = (() => {
    const bashEntry = (hooks.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>).find(
      (e) => e.matcher === 'Bash',
    );
    const cmd = bashEntry!.hooks.map((h) => h.command).find((c) => c.includes('rtk hook claude'));
    if (!cmd) throw new Error('rtk hook command not found in the Bash PreToolUse entry');
    return cmd;
  })();

  // Run the exact shipped hook command with a fake `rtk` first on PATH; return whether
  // rtk was actually invoked (`rtk hook …`) and what the hook emitted on stdout.
  function runRtkHook(command: string): { stdout: string; rtkInvoked: boolean } {
    const dir = mkdtempSync(join(tmpdir(), 'rtk-guard-'));
    try {
      const marker = join(dir, 'invoked');
      const fakeRtk = join(dir, 'rtk');
      writeFileSync(
        fakeRtk,
        `#!/usr/bin/env bash\nif [ "$1" = "hook" ]; then cat >/dev/null; printf X >> ${JSON.stringify(
          marker,
        )}; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"rtk-rewritten"}}}'; fi\n`,
      );
      chmodSync(fakeRtk, 0o755);
      const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
      const stdout = execFileSync('bash', ['-c', rtkCommand], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });
      return { stdout, rtkInvoked: existsSync(marker) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('does NOT route a piped single-file vitest run through rtk (runs verbatim, filter preserved)', () => {
    const res = runRtkHook(
      'cd packages/operator-core && npx vitest run lib/agent-tools/coordination/presence-snapshot-targeted.test.ts 2>&1 | grep -A 30 "error when mocking" | head -50',
    );
    expect(res.rtkInvoked).toBe(false); // rtk never sees vitest → it cannot hijack it into a full-suite run
    expect(res.stdout.trim()).toBe(''); // no updatedInput emitted → Claude runs the original command verbatim
  });

  it('skips rtk for a bare (non-piped) vitest run too — any vitest form, not just the piped one', () => {
    const res = runRtkHook('npx vitest run some/file.test.ts');
    expect(res.rtkInvoked).toBe(false);
  });

  it('still routes a non-vitest command (git status) through rtk for compression', () => {
    const res = runRtkHook('git status');
    expect(res.rtkInvoked).toBe(true);
    expect(res.stdout).toContain('updatedInput'); // rtk produced its rewrite as before
  });
});
