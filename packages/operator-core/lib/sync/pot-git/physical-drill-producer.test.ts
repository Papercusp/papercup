import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runPhysicalDrillCliToExit } from './physical-drill-producer';

// WI-10003741 / P-505 run 23: a producer mode that opened the @papercusp/locks
// pg pool wrote its receipt and then never exited, so the scenario's ssh call
// hung. The CLI must end the process itself once the result is flushed.

function deferredStream() {
  const chunks: string[] = [];
  const pending: Array<() => void> = [];
  return {
    chunks,
    flush: () => {
      while (pending.length) pending.shift()!();
    },
    write: vi.fn((chunk: string, callback: (error?: Error | null) => void) => {
      chunks.push(chunk);
      pending.push(() => callback());
      return true;
    }),
  };
}

describe('runPhysicalDrillCliToExit', () => {
  it('writes the result and exits 0 only after stdout has flushed', async () => {
    const stdout = deferredStream();
    const stderr = deferredStream();
    const exit = vi.fn();
    const done = runPhysicalDrillCliToExit(['phase-d-dirty', 'run-1'], {
      run: async (argv) => ({ mode: argv[0], reset: false }),
      stdout,
      stderr,
      exit,
    });
    await vi.waitFor(() => expect(stdout.write).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();
    stdout.flush();
    await done;
    expect(stdout.chunks).toEqual(['{"mode":"phase-d-dirty","reset":false}\n']);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('reports a failed mode on stderr and exits 1 after stderr has flushed', async () => {
    const stdout = deferredStream();
    const stderr = deferredStream();
    const exit = vi.fn();
    const done = runPhysicalDrillCliToExit(['phase-d-reset'], {
      run: async () => {
        throw new Error('usage: physical-drill-producer phase-d-reset <run-id>');
      },
      stdout,
      stderr,
      exit,
    });
    await vi.waitFor(() => expect(stderr.write).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();
    stderr.flush();
    await done;
    expect(stderr.chunks).toEqual(['usage: physical-drill-producer phase-d-reset <run-id>\n']);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('is what the self-exec entry runs, with a real process.exit', () => {
    const source = readFileSync(fileURLToPath(new URL('./physical-drill-producer.ts', import.meta.url)), 'utf8');
    const entry = source.slice(source.indexOf('const invokedPath = process.argv[1];'));
    expect(entry).toContain('runPhysicalDrillCliToExit(process.argv.slice(2)');
    expect(entry).toContain('exit: (code) => process.exit(code)');
    // Setting only exitCode is the shape that hung run 23.
    expect(source).not.toMatch(/process\.exitCode\s*=/);
  });
});
