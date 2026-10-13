import { writeFile } from 'node:fs/promises';

/** Keyboard evidence for the actual URL-backed workspace-name journey.
 * A page-level keyboard call has no locator action timeout. Keep real key
 * events, but stop the journey at the failed character rather than letting
 * its body continue concurrently with global-timeout teardown.
 */
export type KeyboardInputEvidence = {
  character: string;
  expected: string;
  phase: 'press' | 'verify';
  startedAtMs: number;
  durationMs: number;
  outcome: 'passed' | 'failed';
  error?: string;
};

/** Body-only attachments disappear with list reporters on passing runs.
 * Keep the JSON in the test output directory before attaching its path.
 */
export async function attachWorkspaceKeyboardDiagnostics(
  testInfo: {
    outputPath: (name: string) => string;
    attach: (name: string, options: { path: string; contentType: string }) => Promise<void>;
  },
  data: unknown,
): Promise<void> {
  const path = testInfo.outputPath('workspace-keyboard-input-diagnostics.json');
  await writeFile(path, JSON.stringify(data));
  await testInfo.attach('workspace-keyboard-input-diagnostics', {
    path, contentType: 'application/json',
  });
}

export async function withinInputBudget<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          'KEYBOARD_INPUT_TIMEOUT ' + description + ' after ' + timeoutMs + 'ms',
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function typeWorkspaceNameWithKeyboard(
  input: { press: (key: string, options: { delay: number; timeout: number }) => Promise<void> },
  text: string,
  verify: (expected: string) => Promise<void>,
  evidence: KeyboardInputEvidence[],
  timeoutMs = 10_000,
): Promise<void> {
  let entered = '';
  for (const character of text) {
    entered += character;
    for (const phase of ['press', 'verify'] as const) {
      const startedAtMs = Date.now();
      const started = performance.now();
      try {
        await withinInputBudget(
          () => phase === 'press'
            ? input.press(character === ' ' ? 'Space' : character, { delay: 20, timeout: timeoutMs })
            : verify(entered),
          timeoutMs,
          phase + ' workspace-name character ' + JSON.stringify(character),
        );
        evidence.push({ character, expected: entered, phase, startedAtMs,
          durationMs: performance.now() - started, outcome: 'passed' });
      } catch (error) {
        evidence.push({ character, expected: entered, phase, startedAtMs,
          durationMs: performance.now() - started, outcome: 'failed',
          error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
  }
}

/** Runs as a Playwright init script; no layout reads or application changes.
 * Only the fixture workspace-name field is recorded, never credential fields.
 */
export function installWorkspaceKeyboardDiagnostics(): void {
  const diagnostics = {
    timeOrigin: performance.timeOrigin,
    longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
    inputs: [] as Array<{ type: string; atMs: number; value: string; key?: string }>,
    longTasks: [] as Array<{ atMs: number; durationMs: number }>,
    heartbeatGaps: [] as Array<{ atMs: number; gapMs: number }>,
  };
  Object.assign(window, { __tutorialKeyboardDiagnostics: diagnostics });
  for (const type of ['keydown', 'beforeinput', 'input', 'keyup']) {
    document.addEventListener(type, event => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)
        || target.getAttribute('aria-label') !== 'Workspace name') return;
      if (diagnostics.inputs.length >= 100) return;
      diagnostics.inputs.push({ type, atMs: Date.now(), value: target.value,
        ...(event instanceof KeyboardEvent ? { key: event.key } : {}) });
    }, true);
  }
  if (diagnostics.longTaskSupported) {
    new PerformanceObserver(entries => {
      for (const entry of entries.getEntries()) {
        if (diagnostics.longTasks.length < 100) diagnostics.longTasks.push({
          atMs: performance.timeOrigin + entry.startTime, durationMs: entry.duration,
        });
      }
    }).observe({ type: 'longtask', buffered: true });
  }
  let previous = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - previous > 1000 && diagnostics.heartbeatGaps.length < 100) {
      diagnostics.heartbeatGaps.push({ atMs: Date.now(), gapMs: now - previous });
    }
    previous = now;
  }, 250);
}
