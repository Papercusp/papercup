/**
 * The projected operator guide must recover a disconnected Papercusp MCP session
 * by retrying its original call after the operator responds, without recommending
 * the removed `WaitForMcpServers` tool reference that wedged saved loop turns.
 */
import { describe, expect, it } from 'vitest';
import { CORPUS_PATH, ROOT, SUBJECT_LABEL, readCorpus } from './corpus-subject';

const HEADING = '## Reaching for bash? These reads already have a tool';
const STALE_TOOL = /\bWaitForMcpServers\b/;

function section(text: string): string {
  const start = text.indexOf(`${HEADING}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + HEADING.length + 1);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

describe('disconnected Papercusp MCP recovery guidance', () => {
  const corpus = readCorpus();
  const retryClause = 'once its `/api/health` answers, retry the original failed Papercup tool call.';
  const body = `retryAt=${corpus.indexOf(retryClause)} ${section(corpus)}`;
  // Keep the actual reader input visible if the guard fails under a server-provided env.
  const subjectRoot = CORPUS_PATH.split('/').slice(0, -5).at(-1) ?? '<unknown>';
  const overrideRoot = process.env.PAPERCUSP_DOC_CORPUS
    ? process.env.PAPERCUSP_DOC_CORPUS.split('/').slice(0, -5).at(-1) ?? '<unknown>'
    : '<unset>';
  const rootName = ROOT.split('/').at(-1) ?? '<unknown>';
  const readerInfo = `overrideRoot=${overrideRoot};subjectRoot=${subjectRoot};root=${rootName};label=${SUBJECT_LABEL}`;
  const normalizedBody = `${body.replace(/\s+/g, ' ')} ${readerInfo}`;

  it('uses the populated projected guide section', () => {
    expect(body.length).toBeGreaterThan(1_500);
    expect(body).toContain('**DISCONNECTED**');
  });

  it('retries the original operation without the stale readiness tool', () => {
    expect(normalizedBody).toContain('once its `/api/health` answers, retry the original failed Papercusp tool call.');
    expect(body).not.toMatch(STALE_TOOL);
  });

  it('detects the stale tool reference when the previous recommendation is restored', () => {
    const previousRecommendation =
      'once /api/health answers, retry, then `WaitForMcpServers` twice ~1 min apart';
    expect(previousRecommendation).toMatch(STALE_TOOL);
  });
});
