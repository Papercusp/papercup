import { describe, it, expect } from 'vitest';
import { mergeClaudeHookSettings } from './papercusp-files';

// mergeClaudeHookSettings is the TS port of install-standalone-mcp.sh's merge_* helpers
// (EI-8191 — make the Claude statusline + CC hooks install on the packaged Mac/Windows apps).
// It merges non-destructively + idempotently into a Claude settings.json object.

const DEST = '/home/u/.papercusp/hooks/cc';
const cmd = (entry: any) => entry.hooks[0].command as string;
const commandsFor = (cfg: any, event: string): string[] =>
  (cfg.hooks?.[event] ?? []).map((e: any) => cmd(e));

describe('mergeClaudeHookSettings — full install into empty settings', () => {
  it('registers every CC hook on its correct event(s) + the statusline', () => {
    const cfg = mergeClaudeHookSettings({}, DEST, { isClaudeSettings: true });

    // PreToolUse: lock-acquire (Edit|Write|MultiEdit) + activity-pre (*) + bash-gate (Bash), in install order.
    expect(commandsFor(cfg, 'PreToolUse')).toEqual([
      `${DEST}/pretooluse-locks-acquire.sh`,
      `${DEST}/pretooluse-activity-report.sh`,
      `${DEST}/pretooluse-bash-resource-gate.sh`,
    ]);
    expect(cfg.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit');
    expect(cfg.hooks.PreToolUse[1].matcher).toBe('*'); // activity-pre
    expect(cfg.hooks.PreToolUse[2].matcher).toBe('Bash');

    // PostToolUse: lock-release + coord + activity + workitem-nudge (in install order).
    expect(commandsFor(cfg, 'PostToolUse')).toEqual([
      `${DEST}/posttooluse-locks-release.sh`,
      `${DEST}/posttooluse-coord-inbox.sh`,
      `${DEST}/posttooluse-activity-report.sh`,
      `${DEST}/workitem-verify-nudge.sh`,
    ]);
    expect(cfg.hooks.PostToolUse[1].matcher).toBe('*'); // coord
    expect(cfg.hooks.PostToolUse[2].matcher).toBe('*'); // activity

    // Session events + Stop.
    expect(commandsFor(cfg, 'SessionStart')).toEqual([`${DEST}/lifecycle-report.sh`]);
    expect(commandsFor(cfg, 'SessionEnd')).toEqual([
      `${DEST}/lifecycle-report.sh`,
      `${DEST}/workitem-verify-nudge.sh`,
    ]);
    expect(commandsFor(cfg, 'Stop')).toEqual([`${DEST}/workitem-verify-nudge.sh`]);

    // UserPromptSubmit: turn-provenance classification (turn-provenance-owner-vs-agent P-003).
    expect(commandsFor(cfg, 'UserPromptSubmit')).toEqual([`${DEST}/userpromptsubmit-provenance.sh`]);
    expect(cfg.hooks.UserPromptSubmit[0].matcher).toBeUndefined(); // fires on every prompt

    // statusLine + the Claude-only project-MCP auto-approve flag.
    expect(cfg.statusLine).toEqual({ type: 'command', command: `${DEST}/statusline-fleet.sh` });
    expect(cfg.enableAllProjectMcpServers).toBe(true);

    // objective-title is copied to disk but intentionally NOT registered (parity with the bash installer).
    const allCmds = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit'].flatMap(
      (e) => commandsFor(cfg, e),
    );
    expect(allCmds.some((c) => c.includes('objective-title'))).toBe(false);
  });
});

describe('mergeClaudeHookSettings — non-destructive + idempotent', () => {
  it('never clobbers a user-defined foreign statusLine', () => {
    const cfg = mergeClaudeHookSettings(
      { statusLine: { type: 'command', command: '/usr/local/bin/my-statusline' } },
      DEST,
      { isClaudeSettings: true },
    );
    expect(cfg.statusLine).toEqual({ type: 'command', command: '/usr/local/bin/my-statusline' });
  });

  it('refreshes OUR statusline in place (matches by path)', () => {
    const cfg = mergeClaudeHookSettings(
      { statusLine: { type: 'command', command: `${DEST}/statusline-fleet.sh` } },
      DEST,
    );
    expect(cfg.statusLine).toEqual({ type: 'command', command: `${DEST}/statusline-fleet.sh` });
  });

  it('preserves a user hook while adding ours (foreign entries survive)', () => {
    const foreign = { matcher: 'Edit', hooks: [{ type: 'command', command: '/opt/user/lint.sh' }] };
    const cfg = mergeClaudeHookSettings({ hooks: { PreToolUse: [foreign] } }, DEST);
    expect(cfg.hooks.PreToolUse[0]).toEqual(foreign); // untouched, still first
    expect(commandsFor(cfg, 'PreToolUse')).toContain(`${DEST}/pretooluse-locks-acquire.sh`);
    expect(commandsFor(cfg, 'PreToolUse')).toContain(`${DEST}/pretooluse-bash-resource-gate.sh`);
  });

  it('is idempotent — re-merging the same object adds no duplicate entries', () => {
    const once = mergeClaudeHookSettings({}, DEST, { isClaudeSettings: true });
    const snapshot = JSON.stringify(once);
    const twice = mergeClaudeHookSettings(once, DEST, { isClaudeSettings: true });
    expect(JSON.stringify(twice)).toBe(snapshot);
  });
});

describe('mergeClaudeHookSettings — graceful degradation via `present`', () => {
  it('with only the statusline present, sets statusLine and NOTHING else', () => {
    const cfg = mergeClaudeHookSettings({}, DEST, {
      present: new Set(['statusline-fleet.sh']),
      isClaudeSettings: true,
    });
    expect(cfg.statusLine).toEqual({ type: 'command', command: `${DEST}/statusline-fleet.sh` });
    expect(cfg.hooks).toEqual({}); // no lock/coord/etc entries
    expect(cfg.enableAllProjectMcpServers).toBeUndefined(); // gated on the lock hooks
  });

  it('does NOT set the Claude-only project-MCP flag when isClaudeSettings is false (codex home)', () => {
    const cfg = mergeClaudeHookSettings({}, DEST, {});
    expect(cfg.enableAllProjectMcpServers).toBeUndefined();
    // but the hooks + statusline still register.
    expect(commandsFor(cfg, 'PreToolUse')).toContain(`${DEST}/pretooluse-locks-acquire.sh`);
  });

  it('EI-8997 follow-up: a co-located FOREIGN command survives a re-merge (command-level filter, not whole-entry)', () => {
    // Reproduces a real live-settings.json shape: ONE PreToolUse entry mixing our
    // stale bash-gate command with a third-party command under the SAME matcher.
    // A whole-entry drop (the pre-fix behavior) silently destroyed the foreign one.
    const mixed = {
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: `${DEST}/pretooluse-bash-resource-gate.sh` },
        { type: 'command', command: '/usr/local/bin/rtk hook claude' },
      ],
    };
    const cfg = mergeClaudeHookSettings({ hooks: { PreToolUse: [mixed] } }, DEST);
    const bashEntries = (cfg.hooks.PreToolUse as any[]).filter((e) => e.matcher === 'Bash');
    const allBashCmds = bashEntries.flatMap((e) => e.hooks.map((h: any) => h.command));
    expect(allBashCmds).toContain('/usr/local/bin/rtk hook claude'); // foreign command preserved
    expect(allBashCmds).toContain(`${DEST}/pretooluse-bash-resource-gate.sh`); // ours refreshed
  });
});
