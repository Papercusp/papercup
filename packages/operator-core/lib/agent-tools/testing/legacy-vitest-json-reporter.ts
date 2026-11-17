/** Extend the executing Vitest 1–3 JSON serializer with resolved runtime facts. */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface LegacyFile { filepath: string; projectName?: string }
interface LegacyProject {
  getName?: () => string;
  config: { name?: string; root: string; provide?: Record<string, unknown> };
}
export interface LegacyVitestContext {
  config: { root: string };
  projects?: LegacyProject[];
  state: { getFiles(): LegacyFile[] };
}
interface JsonReporter {
  onInit(ctx: LegacyVitestContext): void;
  onFinished(files?: LegacyFile[]): Promise<void>;
  writeReport(report: string): Promise<void>;
}
type JsonReporterConstructor = new (options?: Record<string, unknown>) => JsonReporter;

export function withRuntimeTestLayers(Base: JsonReporterConstructor): JsonReporterConstructor {
  return class extends Base {
    private runtime!: {
      schemaVersion: number; root: string; runGroupId?: string; workspaceId?: string; harnessSlug?: string;
    };
    private context!: LegacyVitestContext;
    private projects: Array<{ name: string; root: string; testLayer: unknown }> = [];
    private files: Array<{ filePath: string; projectRoot?: string; testLayer?: unknown }> = [];

    override onInit(ctx: LegacyVitestContext): void {
      super.onInit(ctx);
      this.context = ctx;
      this.runtime = { schemaVersion: 1, root: ctx.config.root,
        runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP,
        workspaceId: process.env.PAPERCUSP_WORKSPACE_ID,
        harnessSlug: process.env.PAPERCUSP_TEST_RUN_HARNESS };
      this.projects = (ctx.projects ?? []).map(project => ({
        name: project.getName?.() ?? project.config.name ?? '', root: project.config.root,
        testLayer: project.config.provide?.papercuspTestLayer,
      }));
    }

    override async onFinished(files = this.context.state.getFiles()): Promise<void> {
      this.files = files.map(file => {
        // Vitest 2's getProjectByName silently falls back to a different project.
        const matches = this.projects.filter(project => project.name === (file.projectName ?? ''));
        const project = matches.length === 1 ? matches[0] : undefined;
        return { filePath: file.filepath, projectRoot: project?.root, testLayer: project?.testLayer };
      });
      await super.onFinished(files);
    }

    override async writeReport(report: string): Promise<void> {
      await super.writeReport(JSON.stringify({ ...JSON.parse(report),
        papercuspRuntime: { ...this.runtime, files: this.files } }));
    }
  };
}

/** Its only runtime dependencies are Node and the child's installed JSON reporter. */
export default class LegacyVitestJsonReporter {
  private reporter?: JsonReporter;
  constructor(private readonly options: Record<string, unknown> = {}) {}
  async onInit(ctx: LegacyVitestContext): Promise<void> {
    const fromChild = createRequire(join(ctx.config.root, 'package.json'));
    const { JsonReporter } = await import(pathToFileURL(fromChild.resolve('vitest/reporters')).href);
    this.reporter = new (withRuntimeTestLayers(JsonReporter))(this.options);
    this.reporter.onInit(ctx);
  }
  async onFinished(files?: LegacyFile[]): Promise<void> {
    if (!this.reporter) throw new Error('legacy_vitest_json_reporter_not_initialized');
    await this.reporter.onFinished(files);
  }
}
