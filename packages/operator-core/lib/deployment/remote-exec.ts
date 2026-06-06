/**
 * RemoteExec — the SSH seam a cloud driver uses to bootstrap a frame
 * (`cloud-deployment-layer-2026-06-06` P-010/P-011).
 *
 * `runScript` pipes a generated bash script to the frame over SSH; `copyFile`
 * stages a file (the per-frame Claude credentials — P-011) via scp. The `spawn`
 * impl is injectable so the driver's install path is unit-testable without a live
 * frame (assert the right script + the credential staging), with the real SSH
 * exec wired by default.
 */
import { spawn as nodeSpawn } from 'node:child_process';

export interface SshTarget {
  host: string;
  user?: string;
  /** Path to the private key (matching the ssh_keys injected at provision). */
  identityFile?: string;
  port?: number;
  /** Extra `ssh`/`scp` flags (e.g. StrictHostKeyChecking). */
  extraArgs?: string[];
}

export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RemoteExec {
  /** Run a bash script on the frame (piped over stdin). Throws on a non-zero exit. */
  runScript(script: string): Promise<RemoteExecResult>;
  /** Copy a local file to the frame (scp). */
  copyFile(localPath: string, remotePath: string): Promise<void>;
}

/** Minimal spawn signature we depend on (injectable for tests). */
export type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { stdio?: unknown },
) => {
  stdin: { write(s: string): void; end(): void } | null;
  stdout: { on(ev: 'data', cb: (d: Buffer) => void): void } | null;
  stderr: { on(ev: 'data', cb: (d: Buffer) => void): void } | null;
  on(ev: 'error', cb: (e: Error) => void): void;
  on(ev: 'close', cb: (code: number | null) => void): void;
};

function sshBaseArgs(t: SshTarget): string[] {
  const args: string[] = [];
  if (t.identityFile) {
    // IdentitiesOnly: offer ONLY this key. Without it the local ssh-agent's whole
    // keyring is tried first and a server's MaxAuthTries disconnects us before the
    // -i key is ever offered ("Too many authentication failures" — hit live
    // 2026-06-06 on a frame install from a dev box with a loaded agent).
    args.push('-i', t.identityFile, '-o', 'IdentitiesOnly=yes');
  }
  if (t.port) args.push('-p', String(t.port));
  args.push(
    '-o',
    'BatchMode=yes',
    // Frames are DISPOSABLE machines on RECYCLED provider IPs — pinning their host
    // keys in the user's known_hosts is meaningless (a fresh OS per provision) and
    // actively breaks installs: a recycled IP with an old pinned key fails every
    // connection with "REMOTE HOST IDENTIFICATION HAS CHANGED" (hit live 2026-06-06,
    // DAL frame). /dev/null + accept-new is the ephemeral-infra standard.
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'LogLevel=ERROR', // silence the per-connection "permanently added" warning
    '-o',
    'ConnectTimeout=10', // fail fast so the ssh-readiness probe paces itself
  );
  if (t.extraArgs) args.push(...t.extraArgs);
  return args;
}

const hostSpec = (t: SshTarget): string => `${t.user ?? 'root'}@${t.host}`;

export function createSshRemoteExec(target: SshTarget, deps: { spawn?: SpawnLike } = {}): RemoteExec {
  const spawn = (deps.spawn ?? (nodeSpawn as unknown as SpawnLike));

  function run(cmd: string, args: string[], stdin?: string): Promise<RemoteExecResult> {
    return new Promise<RemoteExecResult>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        const exitCode = code ?? 0;
        if (exitCode !== 0) {
          reject(new Error(`${cmd} exited ${exitCode}: ${stderr.slice(-800) || stdout.slice(-800)}`));
        } else {
          resolve({ stdout, stderr, exitCode });
        }
      });
      if (stdin != null && child.stdin) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    });
  }

  return {
    async runScript(script) {
      // Pipe the script to a remote `bash -s` over stdin (no temp file on the frame).
      return run('ssh', [...sshBaseArgs(target), hostSpec(target), 'bash -s'], script);
    },
    async copyFile(localPath, remotePath) {
      await run('scp', [...sshBaseArgs(target), localPath, `${hostSpec(target)}:${remotePath}`]);
    },
  };
}
