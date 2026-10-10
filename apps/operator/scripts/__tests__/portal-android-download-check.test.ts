import { describe, expect, it } from 'vitest';
import { assertAuthenticatedArtifact, enterSupportedAccountShell, runDownloadPhases } from '../portal-android-download-check';

describe('Android served download phase evidence', () => {
  it('refuses changed authenticated build before onboarding or click and still cleans', async () => {
    const actions: string[] = [];
    const oracle = {
      resolveServedRelease: ({ html }: { html: string }) => ({ release: html }),
      assertTutorialSourceCustody: () => { actions.push('source'); },
    };
    const result = await runDownloadPhases([
      { phase: 'authenticated-artifact-custody', run: () => assertAuthenticatedArtifact(oracle, { text: async () => 'changed' }, {}, '/portal', 'Gv90') },
      { phase: 'onboarding', run: async () => { actions.push('onboarding'); } },
      { phase: 'click', run: async () => { actions.push('click'); } },
    ], async () => { actions.push('cleanup'); }, async () => ({}));
    expect(result.failedPhase).toBe('authenticated-artifact-custody');
    expect(result.passed).toBe(false);
    expect(actions).toEqual(['cleanup']);
  });
  it('checks authenticated response HTML and source custody for the accepted artifact', async () => {
    let checked = false;
    await assertAuthenticatedArtifact({
      resolveServedRelease: ({ html }: { html: string }) => { expect(html).toBe('authenticated-html'); return { release: 'Gv90' }; },
      assertTutorialSourceCustody: (release: { release: string }, root: string) => { expect(release.release).toBe('Gv90'); expect(root).toBe('/portal'); checked = true; },
    }, { text: async () => 'authenticated-html' }, {}, '/portal', 'Gv90');
    expect(checked).toBe(true);
  });
  it.each([true, false])('uses real account-guide navigation only when welcome is visible (%s)', async visible => {
    const clicked: string[] = [];
    const page = {
      getByRole: (_role: string, opts: { name: string }) => ({ isVisible: async () => visible, click: async () => { clicked.push(opts.name); } }),
      waitForURL: async (predicate: (url: URL) => boolean) => {
        expect(predicate(new URL('https://example.test/?firstRun=deferred&panel=account'))).toBe(true);
        expect(predicate(new URL('https://example.test/'))).toBe(false);
      },
    };
    await enterSupportedAccountShell(page);
    expect(clicked).toEqual(visible ? ['Manage your account and preferences', 'Open account'] : []);
  });
  it.each(['navigation', 'supported-onboarding', 'android-toolbar', 'candidate-hash'])('retains %s failure, stops later actions and cleans the fixture', async phase => {
    const calls: string[] = [];
    const result = await runDownloadPhases([
      { phase: 'admission', run: async () => { calls.push('admission'); } },
      { phase, run: async () => { throw new Error('cookie=private URL=private'); } },
      { phase: 'later', run: async () => { calls.push('later'); } },
    ], async () => { calls.push('cleanup'); }, async () => ({ navigationStatus: 200, androidLinks: 0 }));
    expect(result.failedPhase).toBe(phase);
    expect(result.diagnostics).toEqual({ navigationStatus: 200, androidLinks: 0 });
    expect(calls).toEqual(['admission', 'cleanup']);
    expect(result.cleanup).toBe(true);
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('refuses success if cleanup fails even after hash verification', async () => {
    const result = await runDownloadPhases([{ phase: 'candidate-hash', run: async () => {} }], async () => { throw Error('cleanup'); }, async () => ({}));
    expect(result.cleanup).toBe(false);
    expect(result.passed).toBe(false);
  });
  it('still cleans up when page diagnostics fail', async () => {
    let cleaned = false;
    const result = await runDownloadPhases([{ phase: 'navigation', run: async () => { throw Error(); } }], async () => { cleaned = true; }, async () => { throw Error(); });
    expect(cleaned).toBe(true);
    expect(result.diagnostics).toEqual({ observationFailed: true });
  });
});
