import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { closeSync, createWriteStream, openSync, type WriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';

/** Keep bulk backup bytes outside the operator's event loop. Linux supplies
 * compressor input counters through procfs; other hosts retain the stream
 * transport and its existing progress measurement. No output format changes. */
export function createDumpPipe(
  source: Readable,
  destination: string,
  args: string[],
  platform = process.platform,
) {
  const direct = platform === 'linux';
  let stream: WriteStream | undefined;
  let compressor: ChildProcess;
  if (direct) {
    const fd = openSync(destination, 'wx', 0o600);
    try {
      // spawn duplicates the descriptors. Close ONLY our duplicate of the
      // source afterwards: ChildProcess otherwise resumes/drains it at exit,
      // competing with gzip and silently discarding the remaining bytes.
      compressor = spawn('gzip', args, { stdio: [source, fd, 'pipe'] });
    } finally {
      closeSync(fd);
    }
    source.destroy();
  } else {
    compressor = spawn('gzip', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    stream = createWriteStream(destination);
    source.pipe(compressor.stdin!);
    compressor.stdout!.pipe(stream);
  }

  const output = { finished: false, error: undefined as string | undefined };
  const closed = new Promise<void>((resolve) => {
    if (stream) {
      stream.once('finish', () => { output.finished = true; });
      stream.once('error', (error) => { output.error = `output stream failed: ${error.message}`; });
      if (stream.closed) resolve();
      else stream.once('close', resolve);
    } else {
      compressor.once('close', (code) => {
        output.finished = code === 0;
        resolve();
      });
    }
  });

  return {
    compressor: compressor as ChildProcessByStdio<Writable | null, Readable | null, Readable>,
    direct,
    stream,
    output,
    closed,
    /** Raw bytes consumed by gzip, rather than compressed file size: a small
     * compression buffer must never make a slowly progressing dump look dead.
     * Unknown progress is explicit; it cannot authorize a stall cancellation. */
    async sampleProgress(): Promise<number | null> {
      if (!direct || !compressor.pid) return null;
      try {
        const io = await readFile(`/proc/${compressor.pid}/io`, 'utf8');
        const value = /^rchar:\s*(\d+)$/m.exec(io)?.[1];
        if (value === undefined) return null;
        const bytes = Number(value);
        return Number.isSafeInteger(bytes) ? bytes : null;
      } catch {
        return null;
      }
    },
  };
}
