import { describe, it, expect } from 'vitest';
import { mergeClaudeHookSettings } from './papercusp-files';

// mergeClaudeHookSettings is the TS port of install-standalone-mcp.sh's merge_* helpers
// (EI-8191 — make the Claude statusline + CC hooks install on the packaged Mac/Windows apps).
// It merges non-destructively + idempotently into a Claude settings.json object.

const DEST = '/home/u/.papercusp/hooks/cc';
const cmd = (entry: any) => entry.hooks[0].command as string;
const commandsFor = (cfg: any, event: string): string[] =>
  (cfg.hooks?.[event] ?? []).map((e: any) => cmd(e));
const FILE_WRITE_MATCHER = 'Edit|Write|MultiEdit|mcp__.*__capability_(edit|write|multi_?edit)';
const FILE_EDIT_MATCHER = 'Edit|MultiEdit|mcp__.*__capability_(edit|multi_?edit)';
const FILE_OVERWRITE_MATCHER = 'Write|mcp__.*__capability_write';

describe('mergeClaudeHookSettings — full install into empty settings', () => {
  it('registers every CC hook on its correct event(s) + the statusline', () => {
    const cfg = mergeClaudeHookSettings({}, DEST, { isClaudeSettings: true });

    // PreToolUse: lock-acquire (Edit|Write|MultiEdit) + activity-pre (*) + bash-gate (Bash)
    // + plans-read-guard (Read|Grep, P-003(b)) + ask-gate-mirror
    // (AskUserQuestion|ExitPlanMode, owner-inbox-single-pane P-001) + guard-operator-desktop
    // (browser-navigation MCP tools + Skill, EI-16981) + content-lint (Edit|Write|MultiEdit,
    // P-013, wired WI-5543) + secrets-guard (Edit|Write|MultiEdit, wired WI-5542) +
    // nul-byte-edit-guard (Edit|MultiEdit, EI-18896033546676518) +
    // control-bytes-content-guard (Edit|Write|MultiEdit, EI-20782070131658758) +
    // tool-prompt-weight-guard (Edit|Write|MultiEdit, EI-20204186116417704) +
    // schedule-wakeup-provenance (ScheduleWakeup, EI-18680056073436345) +
    // write-overwrite-guard (Write, EI-19966323166806405) + generated-file-edit-guard
    // (Edit|Write|MultiEdit, claude-md-projection-from-pg-2026-08-10 P-006) +
    // unreserved-migration-guard (Edit|Write|MultiEdit, WI-38352), in install order.
    expect(commandsFor(cfg, 'PreToolUse')).toEqual([
      `${DEST}/pretooluse-locks-acquire.sh`,
      `${DEST}/pretooluse-activity-report.sh`,
      `${DEST}/pretooluse-bash-resource-gate.sh`,
      `${DEST}/pretooluse-plans-read-guard.sh`,
      `${DEST}/ask-gate-mirror.sh`,
      `${DEST}/guard-operator-desktop.mjs`,
      `${DEST}/pretooluse-content-lint.mjs`,
      `${DEST}/pretooluse-secrets-guard.mjs`,
      `${DEST}/pretooluse-nul-byte-edit-guard.mjs`,
      `${DEST}/pretooluse-control-bytes-content-guard.mjs`,
      `${DEST}/pretooluse-tool-prompt-weight-guard.mjs`,
      `${DEST}/pretooluse-schedule-wakeup-provenance.mjs`,
      `${DEST}/pretooluse-write-overwrite-guard.mjs`,
      `${DEST}/pretooluse-generated-file-edit-guard.mjs`,
      `${DEST}/pretooluse-unreserved-migration-guard.mjs`,
    ]);
    // Matchers are asserted BY COMMAND NAME, not by array index. The index form silently
    // re-pointed every assertion below the insertion point whenever a hook was added — the
    // reviewer sees a green suite and an unrelated-looking renumber diff, so a genuinely
    // wrong matcher rides in unnoticed. (The `toEqual` above still pins install ORDER, which
    // is the part that carries meaning: hooks fire in registration order.)
    const matcherOf = (name: string): string | undefined =>
      (cfg.hooks.PreToolUse as any[]).find((e) => cmd(e) === `${DEST}/${name}`)?.matcher;

    expect(matcherOf('pretooluse-locks-acquire.sh')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-activity-report.sh')).toBe('*');
    expect(matcherOf('pretooluse-bash-resource-gate.sh')).toBe('Bash');
    expect(matcherOf('pretooluse-plans-read-guard.sh')).toBe('Read|Grep');
    expect(matcherOf('ask-gate-mirror.sh')).toBe('AskUserQuestion|ExitPlanMode');
    expect(matcherOf('guard-operator-desktop.mjs')).toBe(
      'mcp__playwright__browser_navigate|mcp__claude-in-chrome__navigate|mcp__claude-in-chrome__tabs_create_mcp|Skill',
    );
    expect(matcherOf('pretooluse-content-lint.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-secrets-guard.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-nul-byte-edit-guard.mjs')).toBe(FILE_EDIT_MATCHER);
    // EI-20782070131658758: Write MUST be in this matcher. Its sibling directly above is
    // Edit-only by design, so registering this one on FILE_EDIT_MATCHER would reopen the
    // exact reported hole (a `Write` of NUL-bearing content) while still looking wired.
    expect(matcherOf('pretooluse-control-bytes-content-guard.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-control-bytes-content-guard.mjs')).toContain('Write');
    expect(matcherOf('pretooluse-tool-prompt-weight-guard.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-schedule-wakeup-provenance.mjs')).toBe('ScheduleWakeup');
    expect(matcherOf('pretooluse-write-overwrite-guard.mjs')).toBe(FILE_OVERWRITE_MATCHER);
    expect(matcherOf('pretooluse-generated-file-edit-guard.mjs')).toBe(FILE_WRITE_MATCHER);
    expect(matcherOf('pretooluse-unreserved-migration-guard.mjs')).toBe(FILE_WRITE_MATCHER);

    // PostToolBatch: complete native edit-batch lock release first, then the
    // mid-turn context push (context-injection-audit-2026-07-28 P-015).
    // ⚠ It lives HERE and not on PreToolUse deliberately (D-027) — PreToolUse only
    // injects additionalContext alongside a permissionDecision, and a context hook
    // emitting 'allow' would blanket auto-approve everything it matched. If a future
    // change moves this back to PreToolUse, it will silently inject nothing.
    expect(commandsFor(cfg, 'PostToolBatch')).toEqual([
      `${DEST}/posttoolbatch-locks-release.sh`,
      `${DEST}/posttoolbatch-midturn-context.sh`,
    ]);
    expect(cfg.hooks.PostToolBatch.every((entry: any) => entry.matcher === undefined)).toBe(true);

    // PostToolUse: lock-release + activity (coord-folding, EI-11405) + workitem-nudge +
    // required-field-strand nudge (EI-19374535041074908) + ts-parse nudge
    // (EI-19457231269012320) + no-proc-path-fixture nudge (EI-19968483416347685) +
    // migration-fixture-drift nudge (EI-19359711978838614) +
    // migration-forward-compat nudge (EI-19462877357083817) + tool-prompt-weight nudge
    // (EI-19459260956682226) + mock-cast-escape nudge (WI-37497) + css-design-primitives
    // nudge (EI-20023819609804890) + ask-gate-mirror (in install order). The separate
    // coord-inbox entry is retired — merged into activity.
    expect(commandsFor(cfg, 'PostToolUse')).toEqual([
      `${DEST}/posttooluse-locks-release.sh`,
      `${DEST}/posttooluse-activity-report.sh`,
      `${DEST}/workitem-verify-nudge.sh`,
      `${DEST}/posttooluse-required-field-strand-nudge.mjs`,
      `${DEST}/posttooluse-ts-parse-nudge.mjs`,
      `${DEST}/posttooluse-no-proc-path-fixture-nudge.mjs`,
      `${DEST}/posttooluse-migration-fixture-drift-nudge.mjs`,
      `${DEST}/posttooluse-migration-forward-compat-nudge.mjs`,
      `${DEST}/posttooluse-tool-prompt-weight-nudge.mjs`,
      `${DEST}/posttooluse-mock-cast-escape-nudge.mjs`,
      `${DEST}/posttooluse-css-design-primitives-nudge.mjs`,
      `${DEST}/ask-gate-mirror.sh`,
    ]);
    expect(cfg.hooks.PostToolUse[1].matcher).toBe('*'); // activity (+ coord fold)
    expect(cfg.hooks.PostToolUse[0].matcher).toBe(FILE_WRITE_MATCHER); // lock release mirrors acquire
    expect(cfg.hooks.PostToolUse[3].matcher).toBe('Edit|Write|MultiEdit'); // strand nudge
    expect(cfg.hooks.PostToolUse[4].matcher).toBe('Edit|Write|MultiEdit'); // ts-parse nudge
    expect(cfg.hooks.PostToolUse[5].matcher).toBe('Edit|Write|MultiEdit'); // no-proc-path-fixture nudge
    expect(cfg.hooks.PostToolUse[6].matcher).toBe('Edit|Write|MultiEdit'); // migration-fixture-drift nudge
    expect(cfg.hooks.PostToolUse[7].matcher).toBe('Edit|Write|MultiEdit'); // migration-forward-compat nudge
    expect(cfg.hooks.PostToolUse[8].matcher).toBe('Edit|Write|MultiEdit'); // tool-prompt-weight nudge
    expect(cfg.hooks.PostToolUse[9].matcher).toBe('Edit|Write|MultiEdit'); // mock-cast-escape nudge
    expect(cfg.hooks.PostToolUse[10].matcher).toBe('Edit|Write|MultiEdit'); // css-design-primitives nudge
    expect(cfg.hooks.PostToolUse[11].matcher).toBe('AskUserQuestion|ExitPlanMode');

    // Session events + Stop.
    expect(commandsFor(cfg, 'SessionStart')).toEqual([`${DEST}/lifecycle-report.sh`]);
    expect(commandsFor(cfg, 'SessionEnd')).toEqual([
      `${DEST}/lifecycle-report.sh`,
      `${DEST}/workitem-verify-nudge.sh`,
    ]);
    // Stop: work-item nudge + per-turn journal ping (deterministic-context-carry P-012)
    // + the ask-gate-mirror bounce/mirror (owner-inbox-single-pane P-001).
    expect(commandsFor(cfg, 'Stop')).toEqual([
      `${DEST}/workitem-verify-nudge.sh`,
      `${DEST}/stop-turn-journal.sh`,
      `${DEST}/ask-gate-mirror.sh`,
    ]);
    expect(cfg.hooks.Stop[2].matcher).toBeUndefined(); // fires at every turn end

    // Notification: ask-gate-mirror only (permission-wait capture, P-001).
    expect(commandsFor(cfg, 'Notification')).toEqual([`${DEST}/ask-gate-mirror.sh`]);
    expect(cfg.hooks.Notification[0].matcher).toBeUndefined(); // fires on every notification

    // UserPromptSubmit: turn-provenance classification (turn-provenance-owner-vs-agent P-003)
    // + turn-start memory delta (memory-delivery-unification-2026-07-12 P-003a).
    expect(commandsFor(cfg, 'UserPromptSubmit')).toEqual([
      `${DEST}/userpromptsubmit-provenance.sh`,
      `${DEST}/userpromptsubmit-memory.sh`,
    ]);
    expect(cfg.hooks.UserPromptSubmit[0].matcher).toBeUndefined(); // fires on every prompt
    expect(cfg.hooks.UserPromptSubmit[1].matcher).toBeUndefined(); // fires on every prompt

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

  it('control: a hook absent from `present` does NOT register (calibrates the matcher assertions)', () => {
    // Falsifiability control for the EI-20782070131658758 assertions in the first describe.
    // Those assert control-bytes-content-guard registers on the WRITE matcher; this proves
    // that assertion can FAIL — when the hook is not installed, it registers nowhere. Without
    // this, a registration silently deleted from mergeClaudeHookSettings would leave the
    // positive assertion green-by-vacuity if `matcherOf` ever degraded to a loose match.
    const withoutIt = mergeClaudeHookSettings({}, DEST, {
      present: new Set(['pretooluse-locks-acquire.sh', 'posttooluse-locks-release.sh']),
      isClaudeSettings: true,
    });
    expect(commandsFor(withoutIt, 'PreToolUse')).not.toContain(
      `${DEST}/pretooluse-control-bytes-content-guard.mjs`,
    );

    // Calibration: the REAL subject must still register, or the control above passes for the
    // trivial reason that nothing ever registers.
    const full = mergeClaudeHookSettings({}, DEST, { isClaudeSettings: true });
    expect(commandsFor(full, 'PreToolUse')).toContain(
      `${DEST}/pretooluse-control-bytes-content-guard.mjs`,
    );
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
