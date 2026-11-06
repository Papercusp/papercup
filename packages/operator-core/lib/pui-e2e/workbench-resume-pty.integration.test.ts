/** Actual PUI + Zellij resume contract; operator and psu are private fixtures.
 * This proves terminal routing, not canonical vendor or installed-app acceptance.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { spawn as ptySpawn, type IPty } from '@lydell/node-pty';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import { assertPuiBinaryUnchanged, ensurePuiBinary, resolvePuiWorkbenchZellij, snapshotCurrentPuiBinary } from './pui-binary';
import { describeObserverBlock, pollUntil } from './poll-until';
import { runWorkbenchCommand, waitForWorkbenchSessionEnd } from './workbench-command';
import { VtScreen } from './vt-screen';

const ID = 4241;
const OWNER = 'workbench-resume-fixture';
const TOKEN = 'private-resume-contract';
const COLS = 180;
const ROWS = 50;
type Mode = 'accepted' | 'denied' | 'replaced' | 'running' | 'malformed';
type RejectedMode = Exclude<Mode, 'accepted'>;
type Query = { name: string; args: Record<string, unknown>; authorization?: string };

describe('native selection runs the actual PUI workbench in an isolated Zellij PTY', () => {
  let artifact: ReturnType<typeof snapshotCurrentPuiBinary>;
  let server: Server;
  let root = '';
  let cwd = '';
  let origin = '';
  let mode: Mode = 'accepted';
  let queries: Query[] = [];
  let env: Record<string, string> = {};
  let terminal: IPty | undefined;
  let exitCode: number | undefined;
  let raw = '';
  let session = '';

  beforeAll(() => {
    const source = ensurePuiBinary();
    const zellijPath = resolvePuiWorkbenchZellij(source);
    if (!zellijPath) throw new Error('This native contract requires the real Zellij executable');
    artifact = snapshotCurrentPuiBinary(source, { zellijPath });
    // Test-owned command at PUI's normal sibling-psu seam. Never start a fleet.
    writeFileSync(path.join(artifact.directory, 'psu'), [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.env.RESUME_RECEIPT, JSON.stringify({',
      '  argv: process.argv.slice(2), cwd: process.cwd(),',
      '  tty: [process.stdin.isTTY, process.stdout.isTTY],',
      '  operator: process.env.PUI_OPERATOR, sharedOperator: process.env.PAPERCUSP_OPERATOR_URL,',
      '  session: process.env.ZELLIJ_SESSION_NAME, pane: process.env.ZELLIJ_PANE_ID,',
      '}));',
      'process.stdout.write("RESUME_COMMAND_READY\\r\\n");',
      'require("node:readline").createInterface({input:process.stdin}).on("line", line => {',
      '  fs.writeFileSync(process.env.RESUME_INPUT, line);',
      '  process.stdout.write("RESUME_INPUT=" + line + "\\r\\n");',
      '});',
      '',
    ].join('\n'), { mode: 0o755 });
  }, 900_000);

  beforeEach(async () => {
    expect(inject('operatorIntegrationSubstrate')).toBe('none');
    root = mkdtempSync(path.join(tmpdir(), 'pui-resume-contract-'));
    cwd = path.join(root, "selected directory's workspace");
    for (const directory of ['home', 'config', 'data', 'cache', 'runtime', 'sockets', 'tmp']) {
      mkdirSync(path.join(root, directory), { mode: 0o700 });
    }
    mkdirSync(cwd);
    mode = 'accepted';
    queries = [];
    raw = '';
    session = '';
    exitCode = undefined;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture');
      const send = (body: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // These are fixture ACL controls, not an assertion about loopback auth.
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ error: 'fixture unauthorized' }, 401);
      if (url.pathname === '/api/tui/identity') return send({
        schemaVersion: 1, workspaceId: 'resume-contract',
        store: { id: 'private-resume-store', target: 'fixture', source: 'integration' },
        build: { version: 'fixture', sha: null },
        agentChat: { scope: 'workspace:resume-contract', route: '/api/harness' },
      });
      // `id` is the launch projection's alias for advSessionId. Sending both
      // produces an invalid duplicate serde field, unlike the canonical query.
      const ended = { id: ID, coordOwnerId: OWNER, ownerId: OWNER,
        label: 'Same label', hostname: hostname(), host: hostname(), agent: 'codex', cwd,
        sessionState: 'ended' };
      const roster = { active: [], pending: [], ended: [ended] };
      if (url.pathname === '/api/adv/roster') return send(roster);
      if (url.pathname === '/api/zero-harness/rest-query') {
        const query: Query = { name: url.searchParams.get('name') ?? '',
          args: JSON.parse(url.searchParams.get('args') ?? '{}'), authorization: req.headers.authorization };
        queries.push(query);
        if (query.name === 'advRoster.list') {
          if (mode === 'denied') return send({ error: 'fixture resume denied' }, 403);
          if (mode === 'malformed') return send({ version: 'no-row-envelope' });
          if (mode === 'replaced') ended.coordOwnerId = 'replacement-owner';
          if (mode === 'running') return send({ rows: [{ ...roster, active: [{ ownerId: OWNER, advSessionId: ID }] }] });
          return send({ rows: [roster], version: 'private-roster' });
        }
        if (query.name === 'agentOrders.byOwner' || query.name === 'agentDetail.byOwner') {
          return send({ rows: [{ ownerId: OWNER, mission: { explanation: 'EXACT_OWNER_MISSION' },
            directives: [], directivesTotalOpen: 0, turns: [], members: [] }] });
        }
        return send({ rows: [] });
      }
      return send({ error: `unimplemented private route ${url.pathname}` }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Deliberately do not inherit launch credentials, identities, IPC or Zellij.
    env = {
      PATH: `${artifact.directory}:/usr/bin:/bin`, HOME: path.join(root, 'home'),
      TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL: '/bin/sh', LANG: 'C.UTF-8',
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_RUNTIME_DIR: path.join(root, 'runtime'),
      ZELLIJ_SOCKET_DIR: path.join(root, 'sockets'), TMPDIR: path.join(root, 'tmp'),
      PUI_OPERATOR: origin, PAPERCUSP_OPERATOR_URL: origin, PUI_OPERATOR_TOKEN: TOKEN,
      RESUME_RECEIPT: path.join(root, 'receipt.json'), RESUME_INPUT: path.join(root, 'input.txt'),
    };
  });

  function screen() {
    const vt = new VtScreen(ROWS, COLS);
    vt.feed(raw);
    return vt.text();
  }

  function launch(token = TOKEN) {
    terminal = ptySpawn(artifact.binary, ['workbench', 'resume', String(ID), hostname(), OWNER], {
      name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: root,
      env: { ...env, PUI_OPERATOR_TOKEN: token },
    });
    terminal.onData(chunk => { raw = (raw + chunk).slice(-2_000_000); });
    terminal.onExit(event => { exitCode = event.exitCode; });
    session = `pui-resume-${ID}-${terminal.pid}`;
  }

  async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000) {
    const result = await pollUntil(check, { timeoutMs });
    if (!result.ok) throw new Error(`${label}${describeObserverBlock(result.maxLateMs)}; exit=${exitCode}\n${screen()}`);
  }

  afterEach(async () => {
    try {
      if (session) {
        // Only the fixture's exact session and private socket namespace.
        await runWorkbenchCommand(artifact.zellij!.binary, ['kill-session', session], { env, timeoutMs: 5_000 });
      }
      if (terminal && exitCode === undefined) {
        terminal.kill();
        await waitFor(() => exitCode !== undefined, 'fixture launcher did not exit', 5_000);
      }
      if (session) await waitForWorkbenchSessionEnd(env.ZELLIJ_SOCKET_DIR, session, 5_000);
      const evidenceDir = process.env.PUI_WORKBENCH_RESUME_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(path.join(evidenceDir, `${path.basename(root)}.json`), JSON.stringify({
          mode, binary: artifact.binary, binarySha256: artifact.sha256,
          zellij: artifact.zellij, operator: 'private fixture', vendor: 'test-owned psu fixture',
          session, exitCode, queries, screen: screen(),
          receipt: existsSync(env.RESUME_RECEIPT) ? JSON.parse(readFileSync(env.RESUME_RECEIPT, 'utf8')) : null,
        }, null, 2));
      }
    } finally {
      terminal = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (artifact) {
      assertPuiBinaryUnchanged(artifact.binary, artifact.sha256);
      rmSync(artifact.directory, { recursive: true, force: true });
    }
  });

  test('exact selection opens the focused real command with four owner-scoped sidebars and cleans up on quit', async () => {
    launch();
    await waitFor(() => existsSync(env.RESUME_RECEIPT), 'actual PUI did not start its selected command');
    const receipt = JSON.parse(readFileSync(env.RESUME_RECEIPT, 'utf8'));
    expect(receipt).toMatchObject({ argv: ['--resume', String(ID)], cwd, tty: [true, true],
      operator: origin, sharedOperator: origin, session });
    expect(receipt.pane).toMatch(/^\d+$/);
    await waitFor(() => screen().includes('RESUME_COMMAND_READY'), 'focused command not rendered');
    for (const title of ['Orders', 'Activity', 'Turns', 'Fleet']) expect(screen()).toContain(title);
    terminal!.write('exact-input-4241\r');
    await waitFor(() => existsSync(env.RESUME_INPUT), 'keyboard input did not reach the focused command');
    expect(readFileSync(env.RESUME_INPUT, 'utf8')).toBe('exact-input-4241');
    await waitFor(() => queries.some(q => q.name === 'agentOrders.byOwner')
      && queries.some(q => q.name === 'agentDetail.byOwner' && q.args.view === 'turns')
      && queries.some(q => q.name === 'agentDetail.byOwner' && q.args.view === 'fleet')
      && queries.some(q => q.name === 'agentDetail.byOwner' && !q.args.view), 'sidebar model requests did not reach the selected operator');
    for (const query of queries.filter(q => q.name !== 'advRoster.list')) {
      expect(query.args.ownerId).toBe(OWNER);
      expect(query.authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(queries.find(q => q.name === 'advRoster.list')?.args).toEqual({});
    const dumped = await runWorkbenchCommand(artifact.zellij!.binary, ['--session', session, 'action', 'dump-layout'], { env });
    expect(dumped.status).toBe(0);
    expect(dumped.stdout).toContain('pending:adv:4241');
    const quit = await runWorkbenchCommand(artifact.zellij!.binary, ['--session', session, 'action', 'quit'], { env });
    expect(quit.status).toBe(0);
    await waitFor(() => exitCode !== undefined, 'PUI did not finish after Zellij quit');
    expect(exitCode).toBe(0);
    await waitForWorkbenchSessionEnd(env.ZELLIJ_SOCKET_DIR, session);
    expect(readdirSync(path.join(env.HOME, '.papercusp')).filter(name => name.startsWith(session))).toEqual([]);
    assertPuiBinaryUnchanged(artifact.binary, artifact.sha256);
  }, 60_000);

  test.each<RejectedMode>(['denied', 'replaced', 'running', 'malformed'])('refuses %s selection before Zellij or command launch', async rejected => {
    mode = rejected;
    launch();
    await waitFor(() => exitCode !== undefined, `PUI did not reject ${mode}`);
    expect(exitCode).toBe(1);
    expect(existsSync(env.RESUME_RECEIPT)).toBe(false);
    expect(existsSync(path.join(env.HOME, '.papercusp', `${session}.kdl`))).toBe(false);
    expect(queries.map(q => q.name)).toEqual(['advRoster.list']);
    const reason = { denied: '403', replaced: 'selected session changed',
      running: 'running or starting', malformed: 'no row envelope' }[rejected];
    expect(raw).toContain(reason);
  }, 30_000);

  test('an unauthorized selected operator fails before roster access or command launch', async () => {
    launch('wrong-fixture-token');
    await waitFor(() => exitCode !== undefined, 'PUI did not refuse the fixture credential');
    expect(exitCode).toBe(1);
    expect(raw).toContain('401');
    expect(queries).toEqual([]);
    expect(existsSync(env.RESUME_RECEIPT)).toBe(false);
  }, 30_000);
});
