/** Pinned declaration compiler child; explicit ESM entry for every launcher. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { withFsMutex } from './fs-mutex.mjs';

/**
 * Reuse the pinned compiler's own diagnostics/dependency/emit invalidation. A
 * cancelled slice saves native build info, never a successful publication. The
 * next git-sync invocation resumes it under the existing 120s parent deadline.
 * Cache files are compiler intermediates; generate/check still consume only a
 * completed compile in their fresh isolated output directory.
 */
export async function compileDeclarationsIncrementally(
  repoRoot: string,
  config: string,
  outDir: string,
  { cacheRoot = join(userInfo().homedir, '.cache/papercusp/declarations'),
    budgetMs = 45_000,
    cancellationToken,
    onProgress,
  }: { cacheRoot?: string; budgetMs?: number; cancellationToken?: ts.CancellationToken;
    onProgress?: (checked: number) => void } = {},
): Promise<void> {
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve(repoRoot, config), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error('cannot read declaration compiler configuration');
  const { outDir: _outDir, configFilePath: _configFilePath, ...effective } = parsed.options;
  const key = createHash('sha256').update(JSON.stringify({
    repoRoot: resolve(repoRoot), files: parsed.fileNames, options: effective,
    compiler: createHash('sha256').update(readFileSync(ts.sys.getExecutingFilePath())).digest('hex'),
    version: ts.version,
  })).digest('hex');
  const cache = join(cacheRoot, key);
  await withFsMutex(`declaration-compiler-${key}`, async () => {
    const started = Date.now();
    const token: ts.CancellationToken = cancellationToken ?? {
      isCancellationRequested: () => Date.now() - started >= budgetMs,
      throwIfCancellationRequested() {
        if (this.isCancellationRequested()) throw new ts.OperationCanceledException();
      },
    };
    const buildInfo = join(cache, 'compiler.tsbuildinfo');
    const output = join(cache, 'output');
    mkdirSync(output, { recursive: true });
    const options = { ...parsed.options, outDir: output, incremental: true, tsBuildInfoFile: buildInfo };
    const host = ts.createIncrementalCompilerHost(options);
    const write = host.writeFile.bind(host);
    host.writeFile = (path, text, bom, onError, sources, data) => {
      if (resolve(path) !== buildInfo) return write(path, text, bom, onError, sources, data);
      // A parent timeout cannot leave a half-written checkpoint for the next run.
      const pending = `${buildInfo}.${process.pid}.tmp`;
      writeFileSync(pending, text);
      renameSync(pending, buildInfo);
    };
    const builder = ts.createIncrementalProgram({
      rootNames: parsed.fileNames, options, host,
      configFileParsingDiagnostics: parsed.errors, projectReferences: parsed.projectReferences,
    });
    // TS6 exposes this native builder operation at runtime, but omits it from
    // its public declaration. Refuse another compiler rather than invent parity.
    const checkpoint = (builder as ts.EmitAndSemanticDiagnosticsBuilderProgram & {
      emitBuildInfo?: () => ts.EmitResult;
    }).emitBuildInfo;
    if (!checkpoint) throw new Error('pinned compiler cannot checkpoint declaration work');
    const format = (diagnostics: readonly ts.Diagnostic[]) => ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path, getCurrentDirectory: () => repoRoot, getNewLine: () => '\n',
    });
    try {
      const initial = [
        ...builder.getConfigFileParsingDiagnostics(), ...builder.getOptionsDiagnostics(token),
        ...builder.getGlobalDiagnostics(token), ...builder.getSyntacticDiagnostics(undefined, token),
      ];
      if (initial.length) throw new Error(format(initial));
      let checked = 0;
      while (builder.getSemanticDiagnosticsOfNextAffectedFile(token)) {
        onProgress?.(++checked);
        token.throwIfCancellationRequested();
      }
      // Includes cached errors, not just errors produced in this slice.
      const diagnostics = builder.getSemanticDiagnostics(undefined, token);
      if (diagnostics.length) throw new Error(format(diagnostics));
      let emitted = builder.emit(undefined, undefined, token, true);
      if (emitted.diagnostics.length) throw new Error(format(emitted.diagnostics));
      const outputs = parsed.fileNames.filter((path) => path.endsWith('.mjs')).map((path) => ({
        rel: relative(repoRoot, path).replace(/\.mjs$/, '.d.mts'),
      }));
      // Missing intermediates (e.g. cache cleanup) must trigger actual emit,
      // never a warm no-op which could bless an absent or old artifact.
      if (outputs.some(({ rel }) => !existsSync(join(output, rel)))) {
        emitted = builder.getProgram().emit(undefined, undefined, token, true);
        if (emitted.diagnostics.length || emitted.emitSkipped) throw new Error(format(emitted.diagnostics) || 'declaration emit skipped');
      }
      for (const { rel } of outputs) {
        const destination = join(outDir, rel);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(output, rel), destination);
      }
    } catch (error) {
      if (error instanceof ts.OperationCanceledException) {
        throw new Error(`declaration compiler slice incomplete; checkpoint saved for resumption (${key})`);
      }
      throw error;
    } finally {
      checkpoint.call(builder);
    }
  }, { timeoutMs: 1000, lockRootDir: join(cacheRoot, 'locks') });
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void compileDeclarationsIncrementally(process.argv[2], process.argv[3], process.argv[4]).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
