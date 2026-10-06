/** Candidate tsserver plugin for WI-41095. Production readiness does not use it.
 * The population must be declared independently before the request, including
 * libraries/config files; a loaded-project census is never the declaration. */
import { isAbsolute } from 'node:path';

export const SEMANTIC_COMPLETION_COMMAND = 'papercusp/semanticReferences';
export const SEMANTIC_COMPLETION_SCHEMA = 'papercusp-semantic-completion-v1';
export const SEMANTIC_COMPLETION_TYPESCRIPT_VERSION = '6.0.3';

export interface SemanticProjectPopulation {
  projectName: string;
  anchorFile: string;
  files: string[];
}
export interface SemanticCompletionRequest {
  file: string;
  line: number;
  offset: number;
  population: SemanticProjectPopulation[];
}
export interface NativeReference {
  file: string;
  start: { line: number; offset: number };
  end: { line: number; offset: number };
}
export interface SemanticCompletionBody {
  schemaVersion: typeof SEMANTIC_COMPLETION_SCHEMA;
  typescriptVersion: typeof SEMANTIC_COMPLETION_TYPESCRIPT_VERSION;
  population: SemanticProjectPopulation[];
  refs: NativeReference[];
}
interface NativeProject {
  getProjectName(): string;
  getFileNames(excludeExternalLibraries: boolean, excludeConfigFiles: boolean): string[];
  isOrphan(): boolean;
  languageServiceEnabled: boolean;
}
/** Private-method bridge is deliberately version-bound and checked at registration. */
export interface NativeSemanticSession {
  cancellationToken: { isCancellationRequested(): boolean };
  projectService: { forEachProject(callback: (project: NativeProject) => void): void };
  getCanonicalFileName(file: string): string;
  getProjectInfoWorker(file: string, project: string, names: boolean,
    defaultInfo: boolean, excludeConfigs: boolean): unknown;
  getReferences(args: { file: string; line: number; offset: number }, simplified: boolean): unknown;
  addProtocolHandler(command: string, handler: (request: { arguments?: unknown }) =>
    { response: SemanticCompletionBody; responseRequired: true }): void;
}

function refuse(reason: string): never {
  throw new Error(`semantic completion refused: ${reason}`);
}
function cancellationCheck(token: { isCancellationRequested(): boolean }): void {
  if (token.isCancellationRequested()) refuse('cancelled');
}
function exactPopulation(population: SemanticProjectPopulation[], canonical: (file: string) => string): SemanticProjectPopulation[] {
  if (!Array.isArray(population) || !population.length) refuse('undeclared-population');
  const names = new Set<string>();
  return population.map(project => {
    if (!project || typeof project.projectName !== 'string' || !isAbsolute(project.projectName) ||
        typeof project.anchorFile !== 'string' || !isAbsolute(project.anchorFile) ||
        !Array.isArray(project.files) || !project.files.length ||
        project.files.some(file => typeof file !== 'string' || !isAbsolute(file))) refuse('invalid-population');
    const projectName = canonical(project.projectName);
    const files = project.files.map(canonical).sort();
    if (names.has(projectName) || new Set(files).size !== files.length) refuse('duplicate-population');
    names.add(projectName);
    const anchorFile = canonical(project.anchorFile);
    if (!files.includes(anchorFile)) refuse('undeclared-anchor');
    return { projectName, anchorFile, files };
  }).sort((a, b) => a.projectName.localeCompare(b.projectName));
}

function observedPopulation(session: NativeSemanticSession, declared: SemanticProjectPopulation[]): SemanticProjectPopulation[] {
  const observed: SemanticProjectPopulation[] = [];
  session.projectService.forEachProject(project => {
    cancellationCheck(session.cancellationToken);
    if (!project.languageServiceEnabled) refuse('disabled-project');
    if (project.isOrphan()) refuse('orphan-project');
    const projectName = session.getCanonicalFileName(project.getProjectName());
    const expected = declared.find(entry => entry.projectName === projectName);
    if (!expected) refuse('extra-project');
    observed.push({ projectName, anchorFile: expected.anchorFile,
      files: project.getFileNames(false, false).map(file => session.getCanonicalFileName(file)).sort() });
  });
  observed.sort((a, b) => a.projectName.localeCompare(b.projectName));
  if (JSON.stringify(observed) !== JSON.stringify(declared)) refuse('project-or-file-population-mismatch');
  return observed;
}

export function registerNativeSemanticCompletion(session: NativeSemanticSession, version: string): void {
  if (version !== SEMANTIC_COMPLETION_TYPESCRIPT_VERSION ||
      typeof session?.addProtocolHandler !== 'function' ||
      typeof session?.getProjectInfoWorker !== 'function' ||
      typeof session?.getReferences !== 'function' ||
      typeof session?.getCanonicalFileName !== 'function' ||
      typeof session?.projectService?.forEachProject !== 'function' ||
      typeof session?.cancellationToken?.isCancellationRequested !== 'function') refuse('unsupported-native-bridge');
  session.addProtocolHandler(SEMANTIC_COMPLETION_COMMAND, request => {
    cancellationCheck(session.cancellationToken);
    const args = request.arguments as SemanticCompletionRequest | undefined;
    if (!args || typeof args.file !== 'string' || !isAbsolute(args.file) ||
        !Number.isSafeInteger(args.line) || args.line < 1 ||
        !Number.isSafeInteger(args.offset) || args.offset < 1) refuse('invalid-query');
    const declared = exactPopulation(args.population, file => session.getCanonicalFileName(file));
    if (!declared.some(project => project.files.includes(session.getCanonicalFileName(args.file)))) refuse('undeclared-query-file');
    const checkPopulation = () => {
      // Load/update every DECLARED graph, including projects not yet loaded.
      // No observed census is allowed to manufacture a missing declaration.
      for (const project of declared) {
        cancellationCheck(session.cancellationToken);
        session.getProjectInfoWorker(project.anchorFile, project.projectName, true, false, false);
        cancellationCheck(session.cancellationToken);
      }
      return observedPopulation(session, declared);
    };
    checkPopulation();
    cancellationCheck(session.cancellationToken);
    const result = session.getReferences({ file: args.file, line: args.line, offset: args.offset }, true) as
      { refs?: NativeReference[]; canceled?: boolean } | undefined;
    // Native traversal can break on cancellation and RETURN partial refs.
    cancellationCheck(session.cancellationToken);
    if (!result || result.canceled || !Array.isArray(result.refs)) refuse('incomplete-native-result');
    const population = checkPopulation();
    cancellationCheck(session.cancellationToken);
    return { responseRequired: true, response: { schemaVersion: SEMANTIC_COMPLETION_SCHEMA,
      typescriptVersion: SEMANTIC_COMPLETION_TYPESCRIPT_VERSION, population, refs: result.refs } };
  });
}

/** The wrapper's custom-command route drops its outer cancellation token.
 * Refuse before/after the RPC independently, including success/body.canceled. */
export async function requestSemanticCompletion(
  request: SemanticCompletionRequest,
  token: { readonly isCancellationRequested: boolean },
  send: (command: string, args: SemanticCompletionRequest) => Promise<unknown>,
): Promise<SemanticCompletionBody> {
  if (token.isCancellationRequested) refuse('outer-cancelled');
  const raw = await send(SEMANTIC_COMPLETION_COMMAND, request) as
    { type?: string; success?: boolean; body?: SemanticCompletionBody & { canceled?: boolean } } | undefined;
  if (token.isCancellationRequested) refuse('outer-cancelled');
  if (raw?.type !== 'response' || raw.success !== true || raw.body?.canceled ||
      raw.body?.schemaVersion !== SEMANTIC_COMPLETION_SCHEMA ||
      raw.body.typescriptVersion !== SEMANTIC_COMPLETION_TYPESCRIPT_VERSION || !Array.isArray(raw.body.refs)) refuse('incomplete-native-response');
  const declared = exactPopulation(request.population, file => file);
  const observed = exactPopulation(raw.body.population, file => file);
  if (JSON.stringify(declared) !== JSON.stringify(observed)) refuse('response-population-mismatch');
  return raw.body;
}

// TypeScript creates a plugin factory for each project, while protocol handlers
// belong to the shared session. Keep successful registration across factories.
const installedSessions = new WeakSet<NativeSemanticSession>();

/** Build as CommonJS for the maintained tsserver plugin/probe-path mechanism. */
export default function semanticCompletionPlugin(modules: { typescript: { version: string } }): {
  create(info: { session?: NativeSemanticSession; languageService: unknown }): unknown;
} {
  return { create(info) {
    if (!info.session) refuse('missing-native-session');
    if (!installedSessions.has(info.session)) {
      registerNativeSemanticCompletion(info.session, modules.typescript.version);
      installedSessions.add(info.session);
    }
    return info.languageService;
  } };
}
