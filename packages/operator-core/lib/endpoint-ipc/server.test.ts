/**
 * Unit tests for the endpoint-ipc reaper (WI-5999). `startEndpointIpcServer`'s
 * wire-protocol behavior is already covered by dev_ipc_echo_e2e.test.ts; this
 * file targets the orphan-socket GC added alongside it.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { gcDeadEndpointSockets } from './server';

describe('gcDeadEndpointSockets (WI-5999)', () => {
  it('reaps only dead-pid bare "<pid>.sock" files; keeps live, own, non-numeric, and voice-prefixed names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'endpoint-ipc-gc-'));
    try {
      writeFileSync(join(dir, '100.sock'), ''); // dead pid → reap
      writeFileSync(join(dir, '200.sock'), ''); // live pid → keep
      writeFileSync(join(dir, `${process.pid}.sock`), ''); // our own → keep
      writeFileSync(join(dir, 'abc.sock'), ''); // non-numeric → ignore
      writeFileSync(join(dir, 'voice-100.sock'), ''); // the OTHER reaper's naming → never touch
      writeFileSync(join(dir, 'other.txt'), ''); // unrelated → ignore

      const reaped = gcDeadEndpointSockets(dir, (pid) => pid === 200);

      expect(reaped).toBe(1);
      expect(existsSync(join(dir, '100.sock'))).toBe(false);
      expect(existsSync(join(dir, '200.sock'))).toBe(true);
      expect(existsSync(join(dir, `${process.pid}.sock`))).toBe(true);
      expect(existsSync(join(dir, 'abc.sock'))).toBe(true);
      expect(existsSync(join(dir, 'voice-100.sock'))).toBe(true);
      expect(existsSync(join(dir, 'other.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 0 when the sockets dir is absent', () => {
    const missing = join(
      tmpdir(),
      `endpoint-ipc-gc-missing-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    expect(gcDeadEndpointSockets(missing, () => false)).toBe(0);
  });

  it('never reaps its own pid even when the injected isAlive would say dead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'endpoint-ipc-gc-self-'));
    try {
      writeFileSync(join(dir, `${process.pid}.sock`), '');
      const reaped = gcDeadEndpointSockets(dir, () => false);
      expect(reaped).toBe(0);
      expect(existsSync(join(dir, `${process.pid}.sock`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
