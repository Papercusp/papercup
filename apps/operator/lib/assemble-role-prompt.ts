/**
 * assembleRolePrompt — slug-resolved role-prompt assembly for chat sessions.
 *
 * ⚠️ DUPLICATE-OF-CANONICAL: this file mirrors
 * `libs/papercusp/packages/orchestrator/src/role-prompt-from-slug.ts`.
 *
 * Why duplicated: Next/Turbopack can only resolve `@papercusp/orchestrator`'s
 * `.js`-extensioned ESM imports when the package is in
 * `next.config.js → transpilePackages`. The change has been made there but
 * a `papercusp:web` restart is needed to pick it up. Until that restart,
 * importing the orchestrator package breaks every `/api/harness/*` route
 * (including pre-existing ones the autonomous workers depend on). So we
 * keep a local copy here.
 *
 * 🔴 CONVERGE: after the next natural restart of `papercusp:web`, this
 * file should be deleted and the chat endpoint should switch to:
 *   import { assembleRolePrompt } from '@papercusp/orchestrator';
 *
 * Until then, any change to the canonical version MUST be mirrored here.
 *
 * The implementation is a faithful port of the canonical version, sharing
 * the same `buildPrompt` algorithm so the assembled text stays
 * byte-identical. Test parity is enforced by the canonical version's tests
 * (which exercise `buildPrompt` + `resolvePromptFile` directly).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { harnessRoot } from '@papercusp/harness/paths';

export type RolePromptMode = 'autonomous' | 'chat';

export interface AssembleRolePromptOptions {
  slug: string;
  role: string;
  featureId?: string;
  mode?: RolePromptMode;
  runId?: string;
  extras?: readonly string[];
  /** Project context to inject — see canonical version for full docs. */
  projectSpec?: {
    projectId: string;
    content: string;
    updatedAt?: string;
  };
}

export interface AssembledPrompt {
  text: string;
  meta: {
    role: string;
    promptFile: string;
    projectDir: string;
    stateDir: string;
    harnessDir: string;
    runId: string;
  };
}

interface RegistryFile { projects?: Array<{ slug?: string; path?: string }> }

function homeDirPath(): string {
  return process.env.HOME ?? homedir();
}

export function lookupProjectDir(slug: string): string | null {
  const registryPath = join(homeDirPath(), '.restart-harness-projects.json');
  if (!existsSync(registryPath)) return null;
  try {
    const data = JSON.parse(readFileSync(registryPath, 'utf8')) as RegistryFile;
    return data.projects?.find((p) => p.slug === slug)?.path ?? null;
  } catch {
    return null;
  }
}

interface HarnessConfig {
  phase?: string;
  phases?: Record<string, unknown>;
  models?: Record<string, string>;
  timeouts?: Record<string, number>;
  promptOverrides?: Record<string, string>;
  dept?: string;
  [k: string]: unknown;
}

function readConfig(stateDir: string): HarnessConfig {
  const path = join(stateDir, 'config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HarnessConfig;
  } catch {
    return {};
  }
}

function configGet<T>(cfg: HarnessConfig, path: string, defaultValue: T): T {
  const segments = path.split('.');
  let cur: unknown = cfg;
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null) return defaultValue;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return defaultValue;
  }
  return (cur as T) ?? defaultValue;
}

function promptCandidates(harnessDir: string, phase: string, dept: string, role: string): string[] {
  const candidates: string[] = [];
  const promptsRoot = join(harnessDir, 'prompts');
  if (phase && dept) candidates.push(join(promptsRoot, phase, 'departments', dept, `${role}.md`));
  if (phase) candidates.push(join(promptsRoot, phase, `${role}.md`));
  if (phase === 'department') candidates.push(join(promptsRoot, 'department', `${role}.md`));
  candidates.push(join(promptsRoot, `${role}.md`));
  return Array.from(new Set(candidates));
}

function resolvePromptFile(harnessDir: string, phase: string, dept: string, role: string): string | null {
  for (const c of promptCandidates(harnessDir, phase, dept, role)) {
    if (existsSync(c)) return c;
  }
  return null;
}

function fileContents(path: string): string {
  try {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

interface BuildPromptInput {
  role: string;
  promptFile: string;
  promptOverride: string;
  stateDir: string;
  harnessDir: string;
  projectDir: string;
  cwdOverride: string;
  featureId: string | null;
  runId: string;
  extras: readonly string[];
}

function buildPrompt(input: BuildPromptInput): string {
  const out: string[] = [];
  out.push(fileContents(input.promptFile));
  if (input.promptOverride) {
    out.push('\n---');
    out.push(`## Droid specialization (from .harness/config.json → promptOverrides.${input.role})\n`);
    out.push(input.promptOverride);
  }
  if (input.role !== 'curator') {
    const mem = fileContents(`${input.stateDir}/memory/summary.md`);
    if (mem) {
      out.push('\n---');
      out.push('## Memory (curated from prior iterations of this run)\n');
      out.push(mem);
    }
  }
  const identity = fileContents(`${input.harnessDir}/identity/${input.role}.md`);
  if (identity) {
    out.push('\n---');
    out.push(`## Your identity (cross-mission memory for the ${input.role} role)\n`);
    out.push(identity);
  }
  out.push('\n---');
  out.push('## Runtime context\n');
  for (const e of input.extras) out.push(`- ${e}`);
  if (input.cwdOverride) {
    out.push(`- Working directory: ${input.cwdOverride} (worktree for ${input.featureId})`);
    out.push(`- Project root: ${input.projectDir} (reference only — you edit the worktree)`);
  } else {
    out.push(`- Working directory: ${input.projectDir}`);
  }
  out.push(`- State directory: ${input.stateDir} (all coordination files live here; shared across worktrees if any)`);
  out.push(`- Run ID: ${input.runId}`);
  if (input.role !== 'curator') {
    out.push('- **Memory discipline:** at the end of your work, if you learned something');
    out.push('  actionable for future iterations (a technique that works, a library that');
    out.push("  doesn't, an invariant that tripped you up), append ONE line to");
    out.push('  `.harness/memory/raw.md` in the format:');
    out.push(`  \`[<ISO-8601-timestamp>] ${input.role} <feature_id-or-dash>: <one-line observation>\``);
    out.push('  Do not dump logs. Do not duplicate existing lines. Skip silently if you');
    out.push('  have nothing generalizable to add.');
  }
  return out.join('\n');
}

export function assembleRolePrompt(opts: AssembleRolePromptOptions): AssembledPrompt {
  const projectDir = lookupProjectDir(opts.slug);
  if (!projectDir) {
    throw new Error(`assembleRolePrompt: harness "${opts.slug}" not registered in ~/.restart-harness-projects.json`);
  }
  const stateDir = join(projectDir, '.harness');
  const harnessDir = harnessRoot();

  const cfg = readConfig(stateDir);
  const phase = (cfg.phase as string) ?? 'staging';
  const dept = configGet<string>(cfg, 'dept', '');

  const promptFile = resolvePromptFile(harnessDir, phase, dept, opts.role);
  if (!promptFile) {
    throw new Error(`assembleRolePrompt: no prompt file found for role "${opts.role}" (phase=${phase}, dept=${dept || 'none'})`);
  }

  let promptOverride = '';
  const ovRaw = configGet<string>(cfg, `promptOverrides.${opts.role}`, '');
  if (ovRaw) {
    if (ovRaw.startsWith('/')) {
      if (existsSync(ovRaw)) promptOverride = readFileSync(ovRaw, 'utf8');
    } else if (ovRaw.startsWith('./') || ovRaw.endsWith('.md') || ovRaw.endsWith('.txt')) {
      const p = join(stateDir, ovRaw.replace(/^\.\//, ''));
      if (existsSync(p)) promptOverride = readFileSync(p, 'utf8');
    } else {
      promptOverride = ovRaw;
    }
  }

  const runId = opts.runId ?? `${Math.floor(Date.now() / 1000)}-${opts.role}${opts.featureId ? `-${opts.featureId}` : ''}`;
  const mode = opts.mode ?? 'autonomous';

  const extras: string[] = [`MODE=${mode}`];
  if (opts.featureId) extras.push(`FEATURE_ID=${opts.featureId}`);
  if (mode === 'chat') {
    extras.push('CHAT=true (you are responding to a user message in real time; do not commit code; write supervisor-notes or .harness/notes/<feature>.md if you want the autonomous worker to act on something)');
  }
  for (const e of opts.extras ?? []) extras.push(e);

  let text = buildPrompt({
    role: opts.role,
    promptFile,
    promptOverride,
    stateDir,
    harnessDir,
    projectDir,
    cwdOverride: '',
    featureId: opts.featureId ?? null,
    runId,
    extras,
  });

  if (opts.projectSpec?.content && opts.projectSpec.content.trim()) {
    const updatedAtNote = opts.projectSpec.updatedAt ? ` · last curated ${opts.projectSpec.updatedAt}` : '';
    text += `\n\n---\n## Project context — ${opts.projectSpec.projectId} (curated by Project Manager${updatedAtNote})\n\n`;
    text += opts.projectSpec.content.trim();
    text += '\n';
  }

  return {
    text,
    meta: { role: opts.role, promptFile, projectDir, stateDir, harnessDir, runId },
  };
}
