import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWorkspaceHostBootstrap,
  parseEc2ConsoleBootstrapStatus,
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_CHANNELS,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_ERROR_MAX_CHARS,
  type WorkspaceHostBootstrapInput,
  type WorkspaceHostBootstrapStatusChannel,
} from './workspace-host-bootstrap';
import { deriveWorkspaceHostCanonicalArtifactUrls } from './workspace-host-build-manifest';

/**
 * The `ec2-console-output` bootstrap status channel (plan aws-byoc-gcp-parity-2026-10-01 D-013,
 * WI-10005172): the bootstrap writes one marker line to /dev/console, EC2 captures it as console
 * output, and the controller parses the LAST marker. The round-trip tests run the RENDERED bash
 * against the TypeScript parser, so neither side is checked against a hand-written copy of the
 * other.
 */

const DIGEST = 'a'.repeat(64);
const ARTIFACTS = deriveWorkspaceHostCanonicalArtifactUrls(DIGEST);
const MARKER = WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER;

function bootstrap(statusChannel?: WorkspaceHostBootstrapStatusChannel): string {
  const input: WorkspaceHostBootstrapInput = {
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    action: 'install',
    hostId: 'host-1',
    release: {
      version: '2026.8.22-1',
      bundleUrl: ARTIFACTS.bundleUrl,
      bundleSha256: DIGEST,
      signatureUrl: ARTIFACTS.signatureUrl,
      signingPublicKey: 'untrusted comment: Papercusp release key\nRWQpublickey',
      signingKeySha256: 'b'.repeat(64),
    },
    migrationId: 'schema-1042',
    minimumNodeMajor: 22,
    service: { name: 'papercusp-workspace', port: 3070 },
    workspaceAuthorizedKeys: [
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARur6lLxx+/iz7rmO8bWK0dgsvHlrS1hemegIRKbYma controller',
    ],
    publicMetadata: { channel: 'canary' },
    ...(statusChannel ? { statusChannel } : {}),
  };
  return buildWorkspaceHostBootstrap(input);
}

/** The rendered report functions, exactly as the bootstrap defines them. */
function reportFunctions(script: string): string[] {
  const lines = script
    .split('\n')
    .filter((line) => line.startsWith('report_status() {') || line.startsWith('report_outcome() {'));
  expect(lines).toHaveLength(2);
  return lines;
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the rendered console report functions with /dev/console redirected to a file, then return
 * what a controller reading the console would see.
 */
function runConsoleReports(body: string): string {
  const functions = reportFunctions(bootstrap('ec2-console-output'));
  const consoleWrite = '> /dev/console';
  const consoleTarget = functions.filter((line) => line.includes(consoleWrite));
  // The substitution below must replace a real write, or the round trip proves nothing.
  expect(consoleTarget).toHaveLength(1);
  const dir = mkdtempSync(join(tmpdir(), 'ec2-console-status-'));
  scratch.push(dir);
  const capture = join(dir, 'console');
  // A console device accumulates every write; a regular file opened with `>` would truncate, so
  // the stand-in appends.
  const script = [
    'set -euo pipefail',
    'BOOTSTRAP_PHASE=""',
    'BOOTSTRAP_ERROR=""',
    ...functions.map((line) => line.replace(consoleWrite, `>> ${capture}`)),
    body,
  ].join('\n');
  const run = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return readFileSync(capture, 'utf8');
}

describe('ec2-console-output bootstrap status channel (D-013)', () => {
  it('is a declared channel', () => {
    expect(WORKSPACE_HOST_BOOTSTRAP_STATUS_CHANNELS).toContain('ec2-console-output');
  });

  it('renders a valid script that reports to the console and nowhere else', () => {
    const script = bootstrap('ec2-console-output');
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
    const [status] = reportFunctions(script);
    expect(status).toContain('/dev/console');
    expect(status).toContain(MARKER);
    expect(status).not.toContain('169.254.169.254');
    expect(status).toContain('|| true');
  });

  it('leaves the GCE channel and the no-channel script without a console report', () => {
    for (const script of [bootstrap('gce-guest-attributes'), bootstrap()]) {
      const [status] = reportFunctions(script);
      expect(status).not.toContain('/dev/console');
      expect(status).not.toContain(MARKER);
    }
  });

  it('round-trips running, then a success, through the rendered bash and the parser', () => {
    const consoleText = runConsoleReports('report_status running');
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toEqual({ state: 'running' });
    const done = runConsoleReports('report_status running\nreport_outcome 0');
    expect(parseEc2ConsoleBootstrapStatus(done)).toEqual({ state: 'succeeded' });
  });

  it('round-trips a failure whose die message contains newlines and carriage returns', () => {
    const consoleText = runConsoleReports(
      [
        'report_status running',
        'BOOTSTRAP_PHASE=harden-os',
        "BOOTSTRAP_ERROR=$'apt-get failed\\r\\nsee the journal'",
        'report_outcome 100',
      ].join('\n'),
    );
    // One report per call: the multi-line message did not split the failure report.
    expect(consoleText.trimEnd().split('\n')).toHaveLength(2);
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toEqual({
      state: 'failed',
      exitCode: 100,
      phase: 'harden-os',
      error: 'apt-get failed  see the journal',
    });
  });

  // EI-25267772765088134: a `set -u` abort never reaches die, so the report used to carry an
  // empty error and the controller saw only 'error='. The abort runs in a subshell with the
  // production EXIT trap, so the outer harness still exits 0.
  it('reports the aborting command for a non-die abort, with single-quoted literals redacted', () => {
    const abort = (command: string) =>
      runConsoleReports(
        [
          'report_status running',
          '( trap \'status=$?; report_outcome "$status"; exit "$status"\' EXIT',
          '  BOOTSTRAP_PHASE=install-runtime',
          `  ${command}`,
          ') || true',
        ].join('\n'),
      );
    expect(parseEc2ConsoleBootstrapStatus(abort('OLLAMA_TMP="$WORK_DIR/ollama"'))).toEqual({
      state: 'failed',
      exitCode: 1,
      phase: 'install-runtime',
      error: 'aborted outside die: OLLAMA_TMP="$WORK_DIR/ollama"',
    });
    const leaked = abort("printf '%s' 'SECRET-TICKET-abc' > /nonexistent-dir-ei25267772765088134/t");
    expect(leaked).not.toContain('SECRET-TICKET-abc');
    expect(parseEc2ConsoleBootstrapStatus(leaked)).toMatchObject({
      state: 'failed',
      error: "aborted outside die: printf '<redacted>' > /nonexistent-dir-ei25267772765088134/t",
    });
    // A die message still wins over the aborting command.
    const died = abort('BOOTSTRAP_ERROR="named failure"; false');
    expect(parseEc2ConsoleBootstrapStatus(died)).toMatchObject({ state: 'failed', error: 'named failure' });
  });

  it('truncates the die message to the report ceiling', () => {
    const consoleText = runConsoleReports(
      [
        'BOOTSTRAP_PHASE=install-runtime',
        `BOOTSTRAP_ERROR=${'x'.repeat(WORKSPACE_HOST_BOOTSTRAP_STATUS_ERROR_MAX_CHARS + 50)}`,
        'report_outcome 1',
      ].join('\n'),
    );
    const parsed = parseEc2ConsoleBootstrapStatus(consoleText);
    expect(parsed).toMatchObject({ state: 'failed', exitCode: 1, phase: 'install-runtime' });
    expect(parsed && parsed.state === 'failed' ? parsed.error : null).toHaveLength(
      WORKSPACE_HOST_BOOTSTRAP_STATUS_ERROR_MAX_CHARS,
    );
  });
});

describe('parseEc2ConsoleBootstrapStatus', () => {
  it('reads nothing from a console with no marker, even one that prints "failed"', () => {
    expect(parseEc2ConsoleBootstrapStatus('')).toBeNull();
    expect(
      parseEc2ConsoleBootstrapStatus(
        '[   12.3] systemd[1]: Failed to start foo.service\r\nfailed exit=1 phase=harden-os error=x\r\n',
      ),
    ).toBeNull();
  });

  it('takes the LAST marker, so a later run supersedes an earlier failure', () => {
    const consoleText = [
      `${MARKER} running`,
      `${MARKER} failed exit=1 phase=harden-os error=first run`,
      'cloud-init: modules final',
      `${MARKER} running`,
    ].join('\r\n');
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toEqual({ state: 'running' });
  });

  it('finds a marker after interleaved kernel output on the same line', () => {
    const consoleText = `[   42.0] audit: type=1400 ${MARKER} succeeded\r\n`;
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toEqual({ state: 'succeeded' });
  });

  it('reads a malformed last marker as no report, never as the older valid one', () => {
    const consoleText = [`${MARKER} failed exit=2 phase=x error=old`, `${MARKER} garbl`].join('\n');
    expect(parseEc2ConsoleBootstrapStatus(consoleText)).toBeNull();
  });

  it('does not mistake a marker-prefixed word for the marker', () => {
    expect(parseEc2ConsoleBootstrapStatus(`${MARKER}_OTHER succeeded\n`)).toBeNull();
  });
});
