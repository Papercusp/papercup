/**
 * Settings → Integrations names no specific provider (plan cupboard-distributable-integrations-
 * 2026-10-10 P-005, SPEC-R-2-P-005). Every card, form and workflow section is driven by what an
 * installed package declares, so a provider installed from the Cupboard needs no app change, and
 * removing one leaves nothing behind.
 *
 * The scan reads the page and its components with comments removed by the TypeScript compiler
 * (design notes may cite providers; shipped code and UI text may not). The one allowed reference
 * is the built-in `SlackSetupCard`, which P-008 deletes once the Slack drill moves to the package
 * (D-001); this test then loses that exception.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIR = __dirname;

/** The page and every component it renders for providers and workflows. */
const SCANNED = [
  'page.tsx',
  'ProviderAppRegistration.tsx',
  'ProviderCredentialsForm.tsx',
  'ProviderOptionsSelect.tsx',
  'TriggerPackSection.tsx',
  'ticket-integrations-client.ts',
];

/** Until P-008 removes the built-in Slack path (D-001). */
const ALLOWED_TOKENS = ['SlackSetupCard'];

const PROVIDER_NAMES = /\b(slack|asana|linear|jira|github|gitlab|discord|notion|trello|zendesk|intercom|gmail|google|outlook|microsoft|facebook|twitter|instagram|linkedin|telegram|whatsapp)\b/i;

function codeWithoutComments(fileName: string, text: string): string {
  return ts.transpileModule(text, {
    fileName,
    compilerOptions: { removeComments: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

function providerMentions(fileName: string, text: string): string[] {
  let code = codeWithoutComments(fileName, text);
  for (const token of ALLOWED_TOKENS) code = code.split(token).join('');
  return code
    .split('\n')
    .filter((line) => PROVIDER_NAMES.test(line))
    .map((line) => line.trim());
}

describe('Settings → Integrations is provider-neutral', () => {
  it.each(SCANNED)('%s names no provider', (file) => {
    expect(providerMentions(file, readFileSync(join(DIR, file), 'utf8'))).toEqual([]);
  });

  it('the scan finds a provider name in code and UI text, and ignores one in a comment', () => {
    expect(providerMentions('x.tsx', 'export const A = () => <b>Connect Asana</b>;')).toHaveLength(1);
    expect(providerMentions('x.ts', "export const id = 'linear';")).toHaveLength(1);
    expect(providerMentions('x.ts', '// Linear decides\nexport const id = 1;')).toEqual([]);
  });

  it('the built-in card it excuses really is provider-specific, so the exception is still needed', () => {
    const card = readFileSync(join(DIR, 'SlackSetupCard.tsx'), 'utf8');
    expect(providerMentions('SlackSetupCard.tsx', card).length).toBeGreaterThan(0);
  });
});
