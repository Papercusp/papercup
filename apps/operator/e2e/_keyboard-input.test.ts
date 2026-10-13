// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachWorkspaceKeyboardDiagnostics, installWorkspaceKeyboardDiagnostics, typeWorkspaceNameWithKeyboard,
  withinInputBudget, type KeyboardInputEvidence } from './_keyboard-input';

afterEach(() => vi.useRealTimers());

describe('workspace keyboard evidence retention', () => {
  it('keeps passing evidence when the reporter discards attachment metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workspace-keyboard-evidence-'));
    const data = { actions: [{ character: 'M', outcome: 'passed' }],
      renderer: { inputs: [{ value: 'M' }] }, hostEventLoopMaxMs: 20, failed: false };
    // A list reporter consumes the descriptor without saving its body.
    const attach = vi.fn(async () => {});
    try {
      await attachWorkspaceKeyboardDiagnostics({ outputPath: name => join(directory, name), attach }, data);
      const path = join(directory, 'workspace-keyboard-input-diagnostics.json');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(data);
      expect(attach).toHaveBeenCalledWith('workspace-keyboard-input-diagnostics', {
        path, contentType: 'application/json',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains failure evidence even when attaching it fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workspace-keyboard-evidence-'));
    const error = new Error('reporter attachment rejected');
    const data = { actions: [{ phase: 'press', outcome: 'failed' }], failed: true };
    try {
      await expect(attachWorkspaceKeyboardDiagnostics({
        outputPath: name => join(directory, name),
        attach: async () => { throw error; },
      }, data)).rejects.toBe(error);
      expect(JSON.parse(await readFile(join(directory,
        'workspace-keyboard-input-diagnostics.json'), 'utf8'))).toEqual(data);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('workspace keyboard journey failure boundary', () => {
  it('uses real targeted key events and verifies every intermediate value', async () => {
    let value = '';
    const press = vi.fn(async (key: string) => { value += key === 'Space' ? ' ' : key; });
    const verify = vi.fn(async (expected: string) => { expect(value).toBe(expected); });
    const evidence: KeyboardInputEvidence[] = [];
    await typeWorkspaceNameWithKeyboard({ press }, 'My workspace', verify, evidence);
    expect(value).toBe('My workspace');
    expect(press.mock.calls.map(([key]) => key)).toEqual(['M', 'y', 'Space', 'w', 'o', 'r', 'k', 's', 'p', 'a', 'c', 'e']);
    expect(verify.mock.calls.map(([expected]) => expected)).toEqual(
      ['M', 'My', 'My ', 'My w', 'My wo', 'My wor', 'My work', 'My works',
        'My worksp', 'My workspa', 'My workspac', 'My workspace']);
    expect(evidence).toHaveLength(24);
    expect(evidence.every(row => row.outcome === 'passed')).toBe(true);
  });

  it('stops at a dropped character without typing later characters', async () => {
    let value = '';
    const press = vi.fn(async (key: string) => { if (key !== 'y') value += key; });
    const evidence: KeyboardInputEvidence[] = [];
    await expect(typeWorkspaceNameWithKeyboard({ press }, 'My workspace',
      async expected => { expect(value).toBe(expected); }, evidence)).rejects.toThrow();
    expect(press.mock.calls.map(([key]) => key)).toEqual(['M', 'y']);
    expect(evidence.at(-1)).toMatchObject({ character: 'y', expected: 'My',
      phase: 'verify', outcome: 'failed' });
  });

  it('bounds a nonresponsive dispatch and never resumes the journey on late completion', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const press = vi.fn(() => pending);
    const verify = vi.fn(async () => {});
    const evidence: KeyboardInputEvidence[] = [];
    const result = typeWorkspaceNameWithKeyboard({ press }, 'My workspace', verify, evidence);
    const failed = expect(result).rejects.toThrow('KEYBOARD_INPUT_TIMEOUT press workspace-name character "M" after 10000ms');
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    finish();
    await Promise.resolve();
    expect(press).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledWith('M', { delay: 20, timeout: 10_000 });
    expect(verify).not.toHaveBeenCalled();
    expect(evidence.at(-1)).toMatchObject({ phase: 'press', character: 'M', outcome: 'failed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a verification that never settles without typing another character', async () => {
    vi.useFakeTimers();
    const press = vi.fn(async () => {});
    const evidence: KeyboardInputEvidence[] = [];
    const result = typeWorkspaceNameWithKeyboard({ press }, 'My',
      () => new Promise<void>(() => {}), evidence);
    const failed = expect(result).rejects.toThrow('KEYBOARD_INPUT_TIMEOUT verify workspace-name character "M"');
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(press).toHaveBeenCalledTimes(1);
    expect(evidence.map(row => row.outcome)).toEqual(['passed', 'failed']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the original action error and clears the diagnostic deadline', async () => {
    vi.useFakeTimers();
    const error = new Error('page closed during dispatch');
    await expect(withinInputBudget(async () => { throw error; }, 1000, 'snapshot')).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// The init-script recorder is exercised against the browser EventTarget model
// independently of the journey helper, including its credential exclusion.
describe('workspace keyboard browser evidence', () => {
  it('records only workspace-name events, with bounded evidence', async () => {
    document.body.innerHTML = '<input aria-label="Workspace name"><input aria-label="Injected credential reference">';
    const observers: Array<(entries: { getEntries: () => PerformanceEntry[] }) => void> = [];
    vi.useFakeTimers();
    vi.stubGlobal('PerformanceObserver', class {
      static supportedEntryTypes: string[] = ['longtask'];
      constructor(callback: typeof observers[number]) { observers.push(callback); }
      observe() {}
    });
    try {
      installWorkspaceKeyboardDiagnostics();
      const inputs = document.querySelectorAll('input');
      inputs[1].value = 'secret-credential';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].value = 'My';
      inputs[0].dispatchEvent(new KeyboardEvent('keyup', { key: 'y', bubbles: true }));
      for (let i = 0; i < 105; i++) inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      observers[0]({ getEntries: () => [{ startTime: 50, duration: 1500 } as PerformanceEntry] });
      const diagnostics = (window as unknown as { __tutorialKeyboardDiagnostics: {
        inputs: Array<{ type: string; value: string; key?: string }>;
        longTasks: Array<{ durationMs: number }>;
      } }).__tutorialKeyboardDiagnostics;
      expect(diagnostics.inputs).toHaveLength(100);
      expect(diagnostics.inputs[0]).toMatchObject({ type: 'keyup', key: 'y', value: 'My' });
      expect(JSON.stringify(diagnostics)).not.toContain('secret-credential');
      expect(diagnostics.longTasks).toEqual([{ atMs: performance.timeOrigin + 50, durationMs: 1500 }]);
    } finally {
      vi.unstubAllGlobals();
      vi.clearAllTimers();
      document.body.replaceChildren();
    }
  });
});
