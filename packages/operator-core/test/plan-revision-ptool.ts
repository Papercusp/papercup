import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { PTOOL_TOOL_NOT_OK_EXIT } from '../../../apps/operator/scripts/ptool.mjs';

function singleReply(text: string): Record<string, unknown> {
  const envelope = JSON.parse(text);
  if (Array.isArray(envelope?.results) && envelope.results.length !== 1) {
    throw new Error('Expected one result from the plan CLI');
  }
  const reply = Array.isArray(envelope?.results) ? envelope.results[0] : envelope;
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    throw new Error('Expected an object from the plan CLI');
  }
  return reply;
}

/** A delivered CAS refusal is observable on an exact retry. Process and delivery failures are not. */
export async function readPlanPtoolReply(command: Promise<{ stdout: string }>, retry?: { slug: string; content: string }) {
  let output: { stdout: string };
  try {
    output = await command;
  } catch (error) {
    if (!retry || !(error instanceof Error)) throw error;
    const failure = error as Error & { code?: number; signal?: string; killed?: boolean; stdout?: string; stderr?: string };
    if (failure.killed || failure.signal) throw error;
    let text: string | undefined;
    if (failure.code === PTOOL_TOOL_NOT_OK_EXIT) {
      text = failure.stdout;
    } else if (failure.code === 1 && !failure.stdout?.trim()) {
      // printResult writes an MCP isError reply to stderr after this line.
      text = failure.stderr?.match(/(?:^|\n)✗ tool returned an error:\r?\n([\s\S]+)$/)?.[1];
    }
    if (!text) throw error;
    let reply: Record<string, unknown>;
    try {
      reply = singleReply(text);
    } catch {
      throw error;
    }
    if (reply.ok === true || (reply.error ?? reply.code) !== 'stale'
      || (reply.slug !== undefined && reply.slug !== retry.slug)
      || reply.currentHash !== hashPlanContent(retry.content)
      || (reply.currentContent !== undefined && reply.currentContent !== retry.content)) throw error;
    return reply;
  }
  return singleReply(output.stdout);
}
