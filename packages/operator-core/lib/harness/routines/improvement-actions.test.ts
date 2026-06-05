import { describe, it, expect } from 'vitest';
// Side-effect import registers the three actions (and exercises every import path).
import { implementKickoff } from './improvement-actions';
import { listSystemActions } from './system-actions';

describe('improvement-actions registration', () => {
  it('registers system:improvement-digest, system:improvement-watchdog and system:improvement-implement', () => {
    const actions = listSystemActions();
    expect(actions).toContain('improvement-digest');
    expect(actions).toContain('improvement-watchdog');
    expect(actions).toContain('improvement-implement');
  });
});

describe('implementKickoff — the dispatch carries the resolve contract (close-loop D-001)', () => {
  it('names the item and the improvements:resolve back-edge', () => {
    const k = implementKickoff({ id: 'EI-12', title: 'null icon lookup crash', attempts: 0 });
    expect(k).toMatch(/EI-12/);
    expect(k).toMatch(/improvements:resolve/);
    expect(k).toMatch(/outcome: 'fixed'/);
    expect(k).toMatch(/could-not-fix/);
    expect(k).toMatch(/needs-human/);
    expect(k).not.toMatch(/Dispatch attempt/); // first attempt → no retry banner
  });

  it('flags a retry so the worker reads earlier attempts first', () => {
    const k = implementKickoff({ id: 'EI-12', title: 'x', attempts: 2 });
    expect(k).toMatch(/Dispatch attempt 3/);
  });
});
