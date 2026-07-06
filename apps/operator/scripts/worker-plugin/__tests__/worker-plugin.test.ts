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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
