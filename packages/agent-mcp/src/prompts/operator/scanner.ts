/**
 * `operator:scanner` — substrate-owned scanner-role prompt (the
 * "Operator persona"). Mirrors apps/operator/lib/operator-prompt-system.ts
 * but resolves the canonical scanner.md fresh on each request so any
 * substrate edits surface immediately to MCP consumers.
 *
 * No arguments — returns the raw scanner persona.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { definePrompt } from '../../define-prompt';
import type { PromptResult } from '../../types';

function findScannerMd(): string | null {
  const candidates = [
    resolve(__dirname, '../../../../../libs/papercusp/packages/harness/prompts/scanner.md'),
    resolve(__dirname, '../../../../libs/papercusp/packages/harness/prompts/scanner.md'),
    resolve(process.cwd(), 'libs/papercusp/packages/harness/prompts/scanner.md'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export default definePrompt({
  name: 'operator:scanner',
  description:
    'Substrate-owned Operator scanner-role prompt. Defines tier table, schema, anti-patterns. No arguments.',
  async render(): Promise<PromptResult> {
    const path = findScannerMd();
    if (!path) {
      throw new Error('Could not locate scanner.md on disk.');
    }
    const text = readFileSync(path, 'utf8');
    return {
      description: 'Operator scanner persona — substrate canonical version.',
      messages: [{ role: 'system', content: { type: 'text', text } }],
    };
  },
});
