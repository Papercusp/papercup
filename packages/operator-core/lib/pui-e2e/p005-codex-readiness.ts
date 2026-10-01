import { posix as posixPath } from 'node:path';

export const CODEX_HOME_SOCKET_PATH_BUDGET_BYTES = 100;

export function codexHomeControlSocketPath(home: string): string {
  return posixPath.join(home, 'app-server-control', 'app-server-control.sock');
}

export function codexHomeFitsControlSocket(home: string): boolean {
  return Buffer.byteLength(codexHomeControlSocketPath(home)) < CODEX_HOME_SOCKET_PATH_BUDGET_BYTES;
}

export type CodexStartupAction = {
  kind: 'trust-folder' | 'skip-update' | 'keep-approval-required' | 'create-first-task';
  keys: string;
};

export function codexStartupAction(screen: string, allowFirstTask: boolean): CodexStartupAction | null {
  if (/Trust this folder\?[\s\S]*?1\. Trust and continue/i.test(screen)) {
    return { kind: 'trust-folder', keys: '\r' };
  }
  if (/Update available[\s\S]*?Skip\b/i.test(screen)) {
    return { kind: 'skip-update', keys: '\x1b[B\r' };
  }
  if (/(?:ask me to approve|Require approval)/i.test(screen)) {
    return { kind: 'keep-approval-required', keys: '\x1b[B\r' };
  }
  if (allowFirstTask && /Agent command center[\s\S]*No tasks yet[\s\S]*\bn\s+new\b/i.test(screen)) {
    return { kind: 'create-first-task', keys: 'n' };
  }
  return null;
}

export function isCodexPromptReady(screen: string): boolean {
  if (/Installing daemon|model:\s*loading|directory:\s*loading/i.test(screen)) return false;
  return /(?:›\s*Ask Codex to do anything|The prompt is yours\.)/i.test(screen);
}

export function codexTaskCompleted(screen: string, prompt: string, expected: RegExp): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  const safeExpected = new RegExp(expected.source, expected.flags.replace(/[gy]/g, ''));
  const visible = normalize(screen);
  return isCodexPromptReady(screen)
    && visible.includes(normalize(prompt))
    && safeExpected.test(visible);
}
