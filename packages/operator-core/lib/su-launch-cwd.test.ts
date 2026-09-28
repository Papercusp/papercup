/**
 * su-launch-cwd.test.ts — the EI-202 prompt-isolation guard at the cwd layer.
 *
 * A psu superuser session must never launch in `$HOME`: there the cwd-level
 * `CLAUDE.md` + `.claude/CLAUDE.md` ARE the owner's personal config, which Claude
 * auto-loads as PROJECT memory (a discovery path the per-session
 * CLAUDE_CONFIG_DIR isolation does NOT govern). resolveSuLaunchCwd relocates a
 * `$HOME` cwd to the internal workspace root; every other cwd is left untouched.
 */
import { describe, expect, it } from 'vitest';
import { resolveSuLaunchCwd } from './su-launch-cwd';

const HOME = '/home/dev';
const INTERNAL = '/home/dev/.papercusp'; // envelope.cwd — under ~, not ~

describe('resolveSuLaunchCwd (EI-202)', () => {
  it('relocates a no-harness $HOME caller cwd to the internal workspace root', () => {
    expect(
      resolveSuLaunchCwd({ harnessSlug: null, callerCwd: HOME, envelopeCwd: INTERNAL, home: HOME }),
    ).toBe(INTERNAL);
  });

  it('relocates even when $HOME carries a trailing slash (path-normalized compare)', () => {
    expect(
      resolveSuLaunchCwd({ harnessSlug: null, callerCwd: `${HOME}/`, envelopeCwd: INTERNAL, home: HOME }),
    ).toBe(INTERNAL);
  });

  it('keeps a non-$HOME caller cwd (a real project dir) — resume-friendly, no leak', () => {
    const projectDir = '/home/dev/papercupai-workspace/papercup';
    expect(
      resolveSuLaunchCwd({ harnessSlug: null, callerCwd: projectDir, envelopeCwd: INTERNAL, home: HOME }),
    ).toBe(projectDir);
  });

  it('keeps a cwd one level below $HOME (only the exact-$HOME case leaks)', () => {
    const sub = '/home/dev/work';
    expect(
      resolveSuLaunchCwd({ harnessSlug: null, callerCwd: sub, envelopeCwd: INTERNAL, home: HOME }),
    ).toBe(sub);
  });

  it('falls back to envelope.cwd when no caller cwd was supplied', () => {
    expect(
      resolveSuLaunchCwd({ harnessSlug: null, callerCwd: null, envelopeCwd: INTERNAL, home: HOME }),
    ).toBe(INTERNAL);
  });

  it('a harness launch always uses the harness repo (envelope.cwd), ignoring the caller cwd', () => {
    const repo = '/home/dev/papercupai-workspace/papercup';
    // Even if the caller cwd were $HOME, a harness launch never uses it.
    expect(
      resolveSuLaunchCwd({ harnessSlug: 'papercup', callerCwd: HOME, envelopeCwd: repo, home: HOME }),
    ).toBe(repo);
  });
});

describe("resolveSuLaunchCwd policy 'caller' (pui-chat-first-ux P-001)", () => {
  const repo = '/home/dev/papercupai-workspace/papercup';
  const project = '/home/dev/code/my-app';
  const existing = new Set([project, repo, HOME]);
  const isDirectory = (path: string) => existing.has(path);
  const base = { harnessSlug: 'papercup', envelopeCwd: repo, home: HOME, isDirectory };

  it('runs a harness launch in the caller directory when the caller opts in', () => {
    expect(resolveSuLaunchCwd({ ...base, callerCwd: project, policy: 'caller' })).toBe(project);
  });

  it('normalizes the honoured caller directory', () => {
    expect(resolveSuLaunchCwd({ ...base, callerCwd: `${project}/`, policy: 'caller' })).toBe(project);
  });

  it('keeps the harness repo for the default policy even when the caller sends a cwd (psu parity)', () => {
    expect(resolveSuLaunchCwd({ ...base, callerCwd: project })).toBe(repo);
    expect(resolveSuLaunchCwd({ ...base, callerCwd: project, policy: 'harness' })).toBe(repo);
  });

  it('never runs in $HOME, even when the caller asks for it (EI-202)', () => {
    expect(resolveSuLaunchCwd({ ...base, callerCwd: HOME, policy: 'caller' })).toBe(repo);
    expect(resolveSuLaunchCwd({ ...base, harnessSlug: null, envelopeCwd: INTERNAL, callerCwd: `${HOME}/`, policy: 'caller' })).toBe(INTERNAL);
  });

  it('falls back to the harness repo when this host cannot see the caller directory', () => {
    expect(resolveSuLaunchCwd({ ...base, callerCwd: '/srv/client-only/app', policy: 'caller' })).toBe(repo);
  });

  it('refuses a relative caller directory', () => {
    expect(resolveSuLaunchCwd({ ...base, callerCwd: 'code/my-app', policy: 'caller',
      isDirectory: () => true })).toBe(repo);
  });

  it('probes the real filesystem by default', () => {
    expect(resolveSuLaunchCwd({ harnessSlug: 'papercup', envelopeCwd: repo, home: HOME,
      callerCwd: process.cwd(), policy: 'caller' })).toBe(process.cwd());
    expect(resolveSuLaunchCwd({ harnessSlug: 'papercup', envelopeCwd: repo, home: HOME,
      callerCwd: '/definitely/not/a/dir/p001', policy: 'caller' })).toBe(repo);
  });
});
