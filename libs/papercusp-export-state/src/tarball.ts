/**
 * tar+gzip the staging directory to <projectDir>/.papercusp/snapshots/<id>.tar.gz.
 *
 * Streams via the system `tar` binary so we don't need a Node-side tar
 * library; same approach Discourse and Sandstorm use. Reproducibility
 * flags (`--sort=name`, `--mtime`, `--owner=0 --group=0 --numeric-owner`)
 * are applied where supported by GNU tar.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { dirname, basename } from 'node:path';

export async function tarGzipStaging(args: {
  stagingDir: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<{ bytesCompressed: number }> {
  await fs.mkdir(dirname(args.outputPath), { recursive: true });
  // tar -C parent-of-staging -cf - basename | gzip > out
  const parent = dirname(args.stagingDir);
  const subdir = basename(args.stagingDir);

  const tarArgs = [
    '-C', parent,
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-cf', '-',
    subdir,
  ];

  return new Promise((resolve, reject) => {
    const tar = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const gzip = spawn('gzip', ['-9', '-n'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = createWriteStream(args.outputPath);

    args.signal?.addEventListener('abort', () => {
      tar.kill('SIGTERM');
      gzip.kill('SIGTERM');
    });

    tar.stdout.pipe(gzip.stdin);
    gzip.stdout.pipe(out);

    let tarErr = '';
    let gzipErr = '';
    tar.stderr.on('data', (d) => (tarErr += d.toString()));
    gzip.stderr.on('data', (d) => (gzipErr += d.toString()));
    tar.on('error', (e) => reject(e));
    gzip.on('error', (e) => reject(e));
    out.on('error', (e) => reject(e));

    let tarDone = false;
    let gzipDone = false;
    const done = async (code: number, who: string, err: string) => {
      if (code !== 0) {
        reject(new Error(`${who} exited ${code}: ${err.trim()}`));
        return;
      }
      if (who === 'tar') tarDone = true;
      if (who === 'gzip') gzipDone = true;
      if (tarDone && gzipDone) {
        out.end(async () => {
          const stat = await fs.stat(args.outputPath);
          resolve({ bytesCompressed: stat.size });
        });
      }
    };
    tar.on('close', (code) => done(code ?? -1, 'tar', tarErr));
    gzip.on('close', (code) => done(code ?? -1, 'gzip', gzipErr));
  });
}
