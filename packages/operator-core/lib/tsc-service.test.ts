/**
 * WI-10003404 / plan host-memory-reduction-2026-09-27 P-004 — the shared typecheck service's pure
 * half (scripts/lib/tsc-service.mjs): which gate runs may use it, which files a scoped verdict
 * needs checked, and rendering API diagnostics in the CLI's own `--pretty false` text so the gate's
 * existing parser reads service output unchanged.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import {
  TSC_SERVICE_ENV,
  TSC_SERVICE_UNIT_TEMPLATE_ENV,
  baselineWithinScope,
  checkedSetFor,
  lineAndCharacter,
  lineStarts,
  readTextOrNull,
  renderDiagnostics,
  serviceProjectFromTscCommand,
  systemdEscapePath,
  tscServiceEligibility,
  tscServiceSocketPath,
  tscServiceTemplateSocket,
  tscServiceTemplateSocketUnit,
  typecheckViaService,
  unescapeSystemctlValue,
} from '../../../scripts/lib/tsc-service.mjs';
// eslint-disable-next-line import/no-relative-packages
import { parseTscErrors } from '../../../scripts/lib/tsc-baseline-gate.mjs';

describe('serviceProjectFromTscCommand', () => {
  it('accepts every leg shape in use today', () => {
    expect(serviceProjectFromTscCommand('npx tsc -p packages/operator-core/tsconfig.json --noEmit --incremental false')).toBe(
      'packages/operator-core/tsconfig.json',
    );
    expect(serviceProjectFromTscCommand('npx --no-install tsc --project scripts/tsconfig.json --noEmit')).toBe('scripts/tsconfig.json');
  });

  it('refuses any flag the service cannot reproduce, rather than guessing', () => {
    expect(serviceProjectFromTscCommand('npx tsc -p a/tsconfig.json --noEmit --strict false')).toBeNull();
    expect(serviceProjectFromTscCommand('npx tsc -p a/tsconfig.json --incremental true')).toBeNull();
    expect(serviceProjectFromTscCommand('node fake-tsc.mjs')).toBeNull();
    expect(serviceProjectFromTscCommand('npx tsc --noEmit')).toBeNull();
  });
});

describe('tscServiceEligibility', () => {
  const base = {
    tscCommand: 'npx tsc -p packages/operator-core/tsconfig.json --noEmit --incremental false',
    explicitFiles: new Set(['packages/operator-core/lib/a.ts']),
    argv: ['--files=packages/operator-core/lib/a.ts'],
    root: '/repo',
    env: {},
  };

  it('routes an explicit --files run to the project config, resolved against root', () => {
    expect(tscServiceEligibility(base)).toEqual({ eligible: true, project: '/repo/packages/operator-core/tsconfig.json' });
  });

  it('keeps every whole-program run on the CLI', () => {
    expect(tscServiceEligibility({ ...base, explicitFiles: null }).eligible).toBe(false);
    expect(tscServiceEligibility({ ...base, argv: [...base.argv, '--update'] }).eligible).toBe(false);
    expect(tscServiceEligibility({ ...base, argv: [...base.argv, '--seed'] }).eligible).toBe(false);
  });

  it(`honours ${TSC_SERVICE_ENV}=0 and a service bound to another checkout`, () => {
    expect(tscServiceEligibility({ ...base, env: { [TSC_SERVICE_ENV]: '0' } }).eligible).toBe(false);
    expect(tscServiceEligibility({ ...base, serviceRoot: '/elsewhere' }).eligible).toBe(false);
    expect(tscServiceEligibility({ ...base, serviceRoot: '/repo/' }).eligible).toBe(true);
  });
});

describe('tscServiceSocketPath', () => {
  it('prefers the explicit override, then XDG_RUNTIME_DIR', () => {
    expect(tscServiceSocketPath({ PAPERCUSP_TSC_SERVICE_SOCKET: '/tmp/x.sock' })).toBe('/tmp/x.sock');
    expect(tscServiceSocketPath({ XDG_RUNTIME_DIR: '/run/user/7' })).toBe('/run/user/7/papercusp-tsc-service.sock');
  });
});

// WI-10005362: hosted hosts run one template instance per checkout.
describe('systemdEscapePath', () => {
  it('matches `systemd-escape --path` (vectors captured from systemd 255)', () => {
    expect(systemdEscapePath('/srv/papercusp/workspaces/papercusp')).toBe('srv-papercusp-workspaces-papercusp');
    expect(systemdEscapePath('/srv/papercusp/workspaces/papercusp-desktop/')).toBe('srv-papercusp-workspaces-papercusp\\x2ddesktop');
    expect(systemdEscapePath('/home/x/.dir/a b/ü')).toBe('home-x-.dir-a\\x20b-\\xc3\\xbc');
    expect(systemdEscapePath('/')).toBe('-');
    expect(systemdEscapePath('/a//b/./c')).toBe('a-b-c');
    expect(systemdEscapePath('/.hidden/x')).toBe('\\x2ehidden-x');
  });

  it('names the socket unit for the resolved checkout', () => {
    expect(tscServiceTemplateSocketUnit('papercusp-tsc-service', '/srv/papercusp/workspaces/papercusp/')).toBe(
      'papercusp-tsc-service@srv-papercusp-workspaces-papercusp.socket',
    );
  });
});

describe('tscServiceTemplateSocket', () => {
  const unit = 'papercusp-tsc-service@srv-w-repo.socket';
  type Call = { command: string; args: string[]; env: Record<string, string | undefined> };
  function fakeRun(results: Array<{ status: number | null; stdout?: string; stderr?: string }>) {
    const calls: Call[] = [];
    const run = (command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      calls.push({ command, args, env: options.env });
      return results[calls.length - 1] ?? { status: 1, stdout: '', stderr: 'unexpected call' };
    };
    return { calls, run };
  }

  it('starts the instance socket, then returns the path systemd bound (without the type suffix)', () => {
    const { calls, run } = fakeRun([
      { status: 0, stdout: '' },
      { status: 0, stdout: '/run/user/1001/papercusp-tsc-service-srv-w-repo.sock (Stream)\n' },
    ]);
    const located = tscServiceTemplateSocket({ template: 'papercusp-tsc-service', root: '/srv/w/repo', env: {}, run });
    expect(located).toEqual({ unit, socketPath: '/run/user/1001/papercusp-tsc-service-srv-w-repo.sock' });
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['systemctl', '--user', 'start', unit],
      ['systemctl', '--user', 'show', '-p', 'Listen', '--value', unit],
    ]);
    // systemctl --user finds the user bus through XDG_RUNTIME_DIR, which an SSH exec may not carry.
    expect(calls[0].env.XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
  });

  it('decodes systemctl show escaping, so an escaped instance path matches the socket on disk', () => {
    // Shape measured on systemd 255 for a checkout whose path holds a `-`: the socket file name
    // holds a literal `\x2d`, which `systemctl show` prints as `\\x2d`.
    const printed = '/run/user/1001/papercusp-tsc-service-srv-ws-papercusp\\\\x2ddesktop.sock (Stream)\n';
    const { run } = fakeRun([{ status: 0 }, { status: 0, stdout: printed }]);
    const located = tscServiceTemplateSocket({ template: 'papercusp-tsc-service', root: '/srv/ws/papercusp-desktop', env: {}, run });
    expect(located).toEqual({
      unit: 'papercusp-tsc-service@srv-ws-papercusp\\x2ddesktop.socket',
      socketPath: '/run/user/1001/papercusp-tsc-service-srv-ws-papercusp\\x2ddesktop.sock',
    });
    expect(unescapeSystemctlValue('a\\xc3\\xbcb\\\\c\\tz')).toBe('aüb\\c\tz');
    expect(unescapeSystemctlValue('/plain/path.sock')).toBe('/plain/path.sock');
  });

  it('reports a failed start without asking for the socket, so the caller falls back to the CLI', () => {
    const { calls, run } = fakeRun([{ status: 5, stderr: 'Unit papercusp-tsc-service@srv-w-repo.socket not found.\n' }]);
    const located = tscServiceTemplateSocket({ template: 'papercusp-tsc-service', root: '/srv/w/repo', env: { XDG_RUNTIME_DIR: '/run/user/9' }, run });
    expect(located).toEqual({ unit, error: expect.stringContaining('not found') });
    expect(calls).toHaveLength(1);
    expect(calls[0].env.XDG_RUNTIME_DIR).toBe('/run/user/9');
  });

  it('refuses a unit that bound no unix socket', () => {
    const { run } = fakeRun([{ status: 0 }, { status: 0, stdout: '\n' }]);
    expect(tscServiceTemplateSocket({ template: 'papercusp-tsc-service', root: '/srv/w/repo', env: {}, run })).toEqual({
      unit,
      error: `${unit} reports no unix socket`,
    });
  });
});

describe('typecheckViaService under a unit template', () => {
  it('falls back (returns null and says why) when the template instance cannot start', async () => {
    const lines: string[] = [];
    const response = await typecheckViaService({
      root: '/nonexistent/checkout',
      project: '/nonexistent/checkout/tsconfig.json',
      files: ['a.ts'],
      label: 'test',
      log: (line) => lines.push(line),
      // A template name no user manager has: the real `systemctl --user start` refuses it.
      env: { [TSC_SERVICE_UNIT_TEMPLATE_ENV]: 'papercusp-tsc-service-test-absent', XDG_RUNTIME_DIR: '/nonexistent/runtime' },
    });
    expect(response).toBeNull();
    expect(lines.join('\n')).toMatch(/TSC_SERVICE unavailable .*papercusp-tsc-service-test-absent@nonexistent-checkout\.socket/);
  });
});

describe('line/column from UTF-16 offsets', () => {
  it('handles LF, CRLF and astral characters the way the CLI counts columns', () => {
    const text = "a\r\nconst s = '🚀';\nx";
    const starts = lineStarts(text);
    expect(starts).toEqual([0, 3, 19]);
    // `;` after the rocket: the rocket is two UTF-16 units, so the column is 14, not 13.
    expect(lineAndCharacter(starts, text.indexOf("';"))).toEqual({ line: 1, character: 13 });
    expect(lineAndCharacter(starts, text.length - 1)).toEqual({ line: 2, character: 0 });
  });
});

describe('renderDiagnostics', () => {
  const root = '/repo';
  const text = 'const a: number = "x";\nconst f: (x: number) => void = (x: string) => {};\n';
  const textFor = (file: string) => (file === '/repo/src/a.ts' ? text : null);

  it('matches `tsc --pretty false`: location, code, chain lines two spaces deeper per level', () => {
    const out = renderDiagnostics(
      [
        { fileName: '/repo/src/a.ts', pos: 6, code: 2322, category: 1, text: "Type 'string' is not assignable to type 'number'." },
        {
          fileName: '/repo/src/a.ts',
          pos: 29,
          code: 2322,
          category: 1,
          text: "Type '(x: string) => void' is not assignable to type '(x: number) => void'.",
          messageChain: [
            {
              pos: 29,
              code: 2328,
              category: 1,
              text: "Types of parameters 'x' and 'x' are incompatible.",
              messageChain: [{ pos: 29, code: 2322, category: 1, text: "Type 'number' is not assignable to type 'string'." }],
            },
          ],
        },
        { fileName: '/repo/src/a.ts', pos: 0, code: 6133, category: 2, text: 'a suggestion, not an error' },
        { pos: 0, code: 5023, category: 1, text: "Unknown compiler option 'x'." },
      ],
      { root, textFor },
    );
    expect(out).toBe(
      "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
        "src/a.ts(2,7): error TS2322: Type '(x: string) => void' is not assignable to type '(x: number) => void'.\n" +
        "  Types of parameters 'x' and 'x' are incompatible.\n" +
        "    Type 'number' is not assignable to type 'string'.\n" +
        "error TS5023: Unknown compiler option 'x'.\n",
    );
  });

  it('is read back by the gate parser with the same per-file attribution', () => {
    const out = renderDiagnostics(
      [{ fileName: '/repo/src/a.ts', pos: 6, code: 2322, category: 1, text: 'x' }],
      { root, textFor },
    );
    expect(parseTscErrors(out)).toEqual([{ file: 'src/a.ts', code: 'TS2322' }]);
  });
});

describe('checkedSetFor', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('checks the named files, exported-type referencers and direct importers — nothing else', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-service-scope-'));
    const write = (rel: string, body: string) => {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    write('lib/shapes.ts', 'export interface Shape { sides: number }\nexport function area() { return 1; }\n');
    write('lib/uses-type.ts', "const s: Shape = { sides: 1 };\n");
    write('lib/sub/imports-rel.ts', "import { area } from '../shapes.js';\narea();\n");
    write('app/imports-alias.ts', "import { area } from '@/lib/shapes';\narea();\n");
    write('lib/unrelated.ts', "import { other } from './other.js';\n");
    write('node_modules/pkg/index.d.ts', 'export type Shape = 1;\n');
    const abs = (rel: string) => join(dir, rel);
    const scope = checkedSetFor({
      root: dir,
      named: ['lib/shapes.ts', 'lib/not-in-program.ts'],
      programFiles: ['lib/shapes.ts', 'lib/uses-type.ts', 'lib/sub/imports-rel.ts', 'app/imports-alias.ts', 'lib/unrelated.ts', 'node_modules/pkg/index.d.ts'].map(abs),
      typeNames: new Set(['Shape']),
      readText: readTextOrNull,
    });
    expect(scope.files.sort()).toEqual(['app/imports-alias.ts', 'lib/shapes.ts', 'lib/sub/imports-rel.ts', 'lib/uses-type.ts'].map(abs).sort());
    expect(scope).toMatchObject({ named: 1, typeReferencing: 1, importers: 2, namedNotInProgram: ['lib/not-in-program.ts'] });
  });

  it('treats an index file as importable by its directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'tsc-service-scope-'));
    mkdirSync(join(dir, 'lib/feature'), { recursive: true });
    writeFileSync(join(dir, 'lib/feature/index.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'lib/caller.ts'), "import { x } from './feature';\n");
    const scope = checkedSetFor({
      root: dir,
      named: ['lib/feature/index.ts'],
      programFiles: [join(dir, 'lib/feature/index.ts'), join(dir, 'lib/caller.ts')],
      typeNames: new Set(),
      readText: readTextOrNull,
    });
    expect(scope.importers).toBe(1);
  });
});

describe('baselineWithinScope', () => {
  it('drops baselined files the service never judged, so they cannot read as improvements', () => {
    expect(baselineWithinScope({ 'a.ts': 2, 'b.ts': 1, '(unattributed)': 1 }, new Set(['a.ts']))).toEqual({ 'a.ts': 2 });
  });
});
