/** Explicit live acceptance: an owned, ended fixture through actual PUI/psu/Codex.
 * No substitute operator or vendor command. This is current-build Linux proof;
 * installed Ubuntu/macOS/Windows acceptance remains a separate requirement.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import { assertPuiBinaryUnchanged, ensurePuiBinary, resolvePuiWorkbenchZellij, snapshotCurrentPuiBinary } from './pui-binary';
import { describeObserverBlock, pollUntil } from './poll-until';
import { runWorkbenchCommand, waitForWorkbenchSessionEnd } from './workbench-command';
import { VtScreen } from './vt-screen';

// A caller supplies an acceptance-only fixture it created through the supported
// launch door. Never select a human/peer session by label or by "latest".
const configuredFixture = process.env.PUI_WORKBENCH_VENDOR_FIXTURE;
describe.skipIf(!configuredFixture)('canonical Workbench vendor resume in a private terminal', () => {
  let fixture: { id: number; ownerId: string; nativeId: string; host: string };
  let artifact: ReturnType<typeof snapshotCurrentPuiBinary>;
  let terminal: IPty | undefined;
  let exitCode: number | undefined;
  let root = '';
  let session = '';
  let raw = '';
  let env: Record<string, string>;
  let rosterSelection: unknown;
  let activeScreen = '';
  let operatorIdentity: unknown;
  let generatedLayout = '';
  let completed = false;
  const operator = process.env.PUI_OPERATOR ?? process.env.PAPERCUSP_OPERATOR_URL ?? '';
  const marker = 'wb_vendor_' + randomUUID().replaceAll('-', '');
  // The requested answer never occurs in keyboard input, excluding terminal echo.
  const response = marker.toUpperCase();
  const prompt = `Acceptance check only. Reply with the uppercase version of this lowercase token: ${marker}. Do not use tools, edit files, or start other work.`;

  const screen = () => {
    const vt = new VtScreen(50, 180);
    vt.feed(raw);
    return vt.text();
  };
  async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000) {
    const result = await pollUntil(check, { timeoutMs });
    if (!result.ok) throw new Error(`${label}${describeObserverBlock(result.maxLateMs)}; exit=${exitCode}\n${screen()}`);
  }
  async function readOperator(route: string) {
    const headers: Record<string, string> = {};
    if (env.PUI_OPERATOR_TOKEN) headers.authorization = `Bearer ${env.PUI_OPERATOR_TOKEN}`;
    const result = await fetch(new URL(route, operator), { headers, signal: AbortSignal.timeout(20_000) });
    if (!result.ok) throw new Error(`Selected operator returned HTTP ${result.status}`);
    return result.json();
  }

  beforeAll(async () => {
    fixture = JSON.parse(configuredFixture!);
    expect(fixture.id).toBeGreaterThan(0);
    expect(Number.isSafeInteger(fixture.id)).toBe(true);
    expect(fixture.host).toBe(hostname());
    expect(fixture.ownerId).toMatch(/^su-[a-f0-9-]{36}$/);
    expect(fixture.nativeId).toMatch(/^[a-f0-9-]{36}$/);
    expect(fixture.ownerId).not.toBe(process.env.PAPERCUSP_SID);
    // This maintained journey is intentionally pinned to the staging API.
    expect(new URL(operator).origin).toBe('http://127.0.0.1:3170');
    const source = ensurePuiBinary();
    const zellijPath = resolvePuiWorkbenchZellij(source);
    if (!zellijPath) throw new Error('Real Zellij is required');
    artifact = snapshotCurrentPuiBinary(source, { zellijPath });
    root = mkdtempSync(path.join(tmpdir(), 'pui-vendor-resume-'));
    for (const name of ['sockets', 'runtime', 'tmp']) mkdirSync(path.join(root, name), { mode: 0o700 });
    // Preserve the installed CLI, real HOME and credential references. psu's
    // bootstrap resolves the selected fixture's own CODEX_HOME and identity.
    env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    for (const key of ['PAPERCUSP_SID', 'PAPERCUSP_OWNER_ID', 'PAPERCUSP_ADV_SESSION_ID',
      'PAPERCUSP_TTY', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID']) delete env[key];
    Object.assign(env, { HOME: homedir(), PATH: `${artifact.directory}:${env.PATH}`,
      TERM: 'xterm-256color', COLORTERM: 'truecolor',
      XDG_RUNTIME_DIR: path.join(root, 'runtime'), ZELLIJ_SOCKET_DIR: path.join(root, 'sockets'),
      TMPDIR: path.join(root, 'tmp'), PUI_OPERATOR: operator, PAPERCUSP_OPERATOR_URL: operator });
    operatorIdentity = await readOperator('/api/tui/identity');
    const query = new URLSearchParams({ name: 'advRoster.list', args: '{}' });
    const payload = await readOperator('/api/zero-harness/rest-query?' + query);
    expect(payload.rows).toHaveLength(1);
    const roster = payload.rows[0];
    const selected = [...roster.active, ...roster.ended].filter(row => (row.advSessionId ?? row.id) === fixture.id);
    expect(selected).toHaveLength(1);
    rosterSelection = selected[0];
    expect(selected[0].ownerId ?? selected[0].coordOwnerId).toBe(fixture.ownerId);
    expect(selected[0].sessionState).toBe('ended');
    expect(selected[0].pidAlive).not.toBe(true);
    expect(selected[0].nativeSession).toMatchObject({ backend: 'codex', rolloutId: fixture.nativeId,
      exactResumeSupported: true, ownerId: fixture.ownerId });
  }, 900_000);

  afterAll(async () => {
    // Cleanup redraws the terminal and removes the generated layout. Preserve
    // both even when the actual vendor never reaches its composer.
    const preCleanupScreen = screen();
    activeScreen ||= preCleanupScreen;
    const layoutPath = session && env && path.join(env.HOME, '.papercusp', `${session}.kdl`);
    if (layoutPath && existsSync(layoutPath)) generatedLayout = readFileSync(layoutPath, 'utf8');
    try {
      if (session && artifact?.zellij) {
        await runWorkbenchCommand(artifact.zellij.binary, ['kill-session', session], { env, timeoutMs: 5_000 });
      }
      if (terminal && exitCode === undefined) {
        terminal.kill();
        await waitFor(() => exitCode !== undefined, 'launcher did not exit during cleanup', 5_000);
      }
      if (session) await waitForWorkbenchSessionEnd(env.ZELLIJ_SOCKET_DIR, session, 10_000);
    } finally {
      const evidenceDir = process.env.PUI_WORKBENCH_RESUME_EVIDENCE_DIR;
      if (evidenceDir && artifact) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(path.join(evidenceDir, 'vendor-resume.json'), JSON.stringify({
          fixture, operator, operatorIdentity, rosterSelection,
          binary: { source: artifact.source, sha256: artifact.sha256 }, zellij: artifact.zellij,
          marker, response, prompt, session, exitCode, completed, activeScreen,
          screen: screen(), preCleanupScreen, generatedLayout,
        }, null, 2));
      }
      if (artifact) {
        assertPuiBinaryUnchanged(artifact.binary, artifact.sha256);
        rmSync(artifact.directory, { recursive: true, force: true });
      }
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('exact ended fixture receives keyboard input and renders a distinct real vendor response', async () => {
    expect(prompt).not.toContain(response);
    terminal = ptySpawn(artifact.binary, ['workbench', 'resume', String(fixture.id), fixture.host, fixture.ownerId], {
      name: 'xterm-256color', cols: 180, rows: 50, cwd: root, env,
    });
    terminal.onData(chunk => { raw = (raw + chunk).slice(-2_000_000); });
    terminal.onExit(event => { exitCode = event.exitCode; });
    session = `pui-resume-${fixture.id}-${terminal.pid}`;
    // Match the installed vendor's actual composer, not an earlier CLI banner.
    await waitFor(() => screen().includes('OpenAI Codex') && /context left|gpt-|model:/i.test(screen()),
      'selected Codex composer did not become ready', 120_000);
    for (const title of ['Orders', 'Activity', 'Turns', 'Fleet']) expect(screen()).toContain(title);
    generatedLayout = readFileSync(path.join(env.HOME, '.papercusp', `${session}.kdl`), 'utf8');
    expect(generatedLayout).toContain('psu');
    expect(generatedLayout).toContain('"--no-picker"');
    expect(generatedLayout).toContain(String(fixture.id));
    expect(screen()).not.toContain(response);
    terminal.write(prompt + '\r');
    await waitFor(() => screen().includes(response), 'distinct uppercase vendor answer was not rendered', 180_000);
    activeScreen = screen();
    // Closing this private multiplexer session must not touch any peer session.
    terminal.write('\x11');
    await waitFor(() => exitCode !== undefined, 'PUI did not exit after Ctrl-q', 15_000);
    expect(exitCode).toBe(0);
    await waitForWorkbenchSessionEnd(env.ZELLIJ_SOCKET_DIR, session, 15_000);
    assertPuiBinaryUnchanged(artifact.binary, artifact.sha256);
    completed = true;
  }, 330_000);
});
