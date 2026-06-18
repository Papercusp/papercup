/**
 * The GDPval deliverable-GENERATION arm (plan benchmark-suite-gdpval-2026-06-17, P-005).
 *
 * GDPval grades a real professional DELIVERABLE (a doc / spreadsheet / deck / …), so the arm must PRODUCE FILES,
 * not a FINAL ANSWER string. This reuses the GAIA ReAct loop ({@link runGaiaAgent}) + its run_python-in-scratch
 * toolset (the agent writes deliverable files via openpyxl / python-docx / python-pptx, or plain .md/.csv/.txt),
 * driven by a deliverable-producing system prompt instead of GAIA's FINAL-ANSWER discipline. After the run we
 * collect the files the agent CREATED (everything not a staged input) and reduce them to text via the P-004
 * resolver — that text is the {@link deliverableSubmission} the pairwise autograder compares to the expert
 * reference.
 *
 * Pure where it can be: {@link buildGdpvalBrief} + {@link collectOutputFileNames} are unit-tested; the LLM,
 * toolset, and filesystem are injected so {@link generateGdpvalDeliverable} runs under a fake with no spend.
 */
import { join } from 'node:path';
import { runGaiaAgent, type GaiaAgentConfig, type GaiaAgentResult, type GaiaToolset, type LlmFn } from '../gaia/agent';
import type { GaiaTask } from '../gaia/dataset';
import { extractFile, type ResolverDeps } from './reference-resolver';

/** The deliverable-producer system prompt — the GDPval analog of GAIA's FINAL-ANSWER prompt. */
export const GDPVAL_AGENT_SYSTEM = [
  'You are an experienced professional producing a real, client-quality work deliverable in response to a task.',
  'Your output will be graded BLIND against a deliverable made by a human expert with ~14 years of experience —',
  'so it must be complete, correct, and professionally formatted, not a sketch or a description of what you would do.',
  '',
  'How to work:',
  '- Read any provided input files first (read_file, or run_python to parse spreadsheets/PDFs).',
  '- Research with web_search + fetch_url when the task needs external facts.',
  '- PRODUCE THE ACTUAL DELIVERABLE AS FILE(S) in your current working directory. Use run_python to create them:',
  '  openpyxl for .xlsx, python-docx for .docx, python-pptx for .pptx; or write .md / .csv / .txt / .html directly.',
  '  Match the format the task asks for; a clear, complete .md or .txt is acceptable when no binary format is required.',
  '- Do NOT merely describe the deliverable — write the files. An empty working directory scores as no deliverable.',
  '- When the deliverable is finished and saved, briefly list the file(s) you created, then stop.',
].join('\n');

/** Build the initial brief: the task prompt + a note about staged input files + the produce-files instruction. */
export function buildGdpvalBrief(prompt: string, stagedInputFiles: string[]): string {
  const inputs = stagedInputFiles.length
    ? `\n\nInput files are staged in your working directory: ${stagedInputFiles.join(', ')}. Read them before producing the deliverable.`
    : '';
  return `${prompt}${inputs}\n\nProduce the complete deliverable as file(s) in your current working directory.`;
}

/** Pure: the agent's output files = everything present after the run that was NOT a staged input (sorted). */
export function collectOutputFileNames(filesAfter: string[], stagedInputs: string[]): string[] {
  const staged = new Set(stagedInputs);
  return filesAfter.filter((f) => !staged.has(f)).sort();
}

/** Injected deps for one generation: the LLM + toolset (live or fake) + the scratch filesystem + office extractor. */
export interface GdpvalGenerationDeps {
  llm: LlmFn;
  tools: GaiaToolset;
  /** The agent's working directory (where run_python executes + writes files). */
  scratchDir: string;
  /** Filenames already staged in scratchDir before the run (the task inputs) — excluded from the deliverable. */
  stagedInputFiles: string[];
  listFiles: (dir: string) => Promise<string[]>;
  readFileBytes: (path: string) => Promise<Uint8Array>;
  /** Office/pdf → text extractor (the resolver's; reuse makeLiveResolverDeps().officeExtract). */
  officeExtract: ResolverDeps['officeExtract'];
  agentConfig?: GaiaAgentConfig;
}

export interface GdpvalGenerationResult {
  /** The produced deliverable bundle reduced to text — the qa-style submission the autograder grades. */
  deliverableText: string;
  /** The files the agent created (the deliverable bundle). */
  outputFiles: string[];
  /** Created files that couldn't be reduced to text (binary the judge can't read), with reasons. */
  excluded: { file: string; reason: string }[];
  /** The underlying agent run (telemetry: turns, tokens, stopReason). */
  agent: GaiaAgentResult;
}

/**
 * Run the generation arm for ONE GDPval task: drive the ReAct agent with the deliverable brief, then collect +
 * reduce the produced files to text. Never throws out of the loop (a task failure stays a task failure).
 */
export async function generateGdpvalDeliverable(
  task: { instanceId: string; prompt: string },
  deps: GdpvalGenerationDeps,
): Promise<GdpvalGenerationResult> {
  const gaiaTask: GaiaTask = {
    taskId: task.instanceId,
    question: buildGdpvalBrief(task.prompt, deps.stagedInputFiles),
    level: 1,
    finalAnswer: '',
    fileName: '',
  };
  const agent = await runGaiaAgent(gaiaTask, { llm: deps.llm, tools: deps.tools }, { systemPrompt: GDPVAL_AGENT_SYSTEM, ...deps.agentConfig });

  const after = await deps.listFiles(deps.scratchDir).catch(() => []);
  const outputs = collectOutputFileNames(after, deps.stagedInputFiles);
  const parts: string[] = [];
  const excluded: { file: string; reason: string }[] = [];
  // extractFile only needs officeExtract for local files (fetchBytes is unused — we read bytes directly).
  const extractDeps: ResolverDeps = { fetchBytes: async () => { throw new Error('local file, no fetch'); }, officeExtract: deps.officeExtract };
  for (const f of outputs) {
    let bytes: Uint8Array;
    try {
      bytes = await deps.readFileBytes(join(deps.scratchDir, f));
    } catch (e) {
      excluded.push({ file: f, reason: `read failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const r = await extractFile(bytes, f, extractDeps);
    if (r.ok) parts.push(`## ${f}\n${r.text}`);
    else excluded.push({ file: f, reason: r.excludeReason });
  }
  return { deliverableText: parts.join('\n\n'), outputFiles: outputs, excluded, agent };
}
