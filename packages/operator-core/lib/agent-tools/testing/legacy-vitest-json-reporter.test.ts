import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRuntimeTestLayers, type LegacyVitestContext } from './legacy-vitest-json-reporter';

afterEach(() => vi.unstubAllEnvs());

describe('legacy Vitest JSON runtime capture', () => {
  function fixture() {
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'run-original');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'workspace');
    vi.stubEnv('PAPERCUSP_TEST_RUN_HARNESS', 'harness');
    const write = vi.fn(async (_report: string) => {});
    class NativeJsonReporter {
      onInit(_ctx: LegacyVitestContext) {}
      async onFinished() { await this.writeReport(JSON.stringify({ success: true, testResults: [] })); }
      async writeReport(report: string) { await write(report); }
    }
    const files = [{ filepath: '/repo/a.integration.test.ts', projectName: 'unit' },
      { filepath: '/repo/ordinary.test.ts', projectName: 'integration' }];
    const ctx: LegacyVitestContext = { config: { root: '/repo' }, state: { getFiles: () => files }, projects: [
      { getName: () => 'unit', config: { root: '/repo', provide: { papercuspTestLayer: 'unit' } } },
      { getName: () => 'integration', config: { root: '/repo', provide: { papercuspTestLayer: 'integration' } } },
    ] };
    const reporter = new (withRuntimeTestLayers(NativeJsonReporter))();
    return { write, ctx, reporter, files };
  }

  it('keeps the native serializer and records project layers independently of filenames', async () => {
    const { write, ctx, reporter } = fixture(); reporter.onInit(ctx); await reporter.onFinished();
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({ success: true, testResults: [], papercuspRuntime: {
      schemaVersion: 1, root: '/repo', runGroupId: 'run-original', workspaceId: 'workspace', harnessSlug: 'harness',
      files: [{ filePath: '/repo/a.integration.test.ts', projectRoot: '/repo', testLayer: 'unit' },
        { filePath: '/repo/ordinary.test.ts', projectRoot: '/repo', testLayer: 'integration' }],
    } });
  });

  it('captures configuration and attribution before test code can change them', async () => {
    const { write, ctx, reporter } = fixture(); reporter.onInit(ctx);
    ctx.projects![0]!.config.provide!.papercuspTestLayer = 'browser';
    vi.stubEnv('PAPERCUSP_TEST_RUN_GROUP', 'different-run'); await reporter.onFinished();
    const runtime = JSON.parse(write.mock.calls[0]![0]).papercuspRuntime;
    expect(runtime.runGroupId).toBe('run-original'); expect(runtime.files[0].testLayer).toBe('unit');
  });

  it.each(['missing', 'duplicate'])('does not fall back to a different project for a %s project', async mode => {
    const { write, ctx, reporter, files } = fixture();
    if (mode === 'missing') files[0]!.projectName = 'unknown'; else ctx.projects!.push(ctx.projects![0]!);
    reporter.onInit(ctx); await reporter.onFinished();
    expect(JSON.parse(write.mock.calls[0]![0]).papercuspRuntime.files[0]).toEqual({ filePath: files[0]!.filepath });
  });
});
