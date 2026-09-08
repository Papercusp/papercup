import { describe, expect, it } from 'vitest';
import { evaluateRenderMatrix, type RenderMatrixContract, type RenderMatrixObservation } from './render-matrix';

const hash = 'a'.repeat(64);
function fixture() {
  const environment = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
    browser: 'chromium', fontSet: 'system', theme: 'light', state: 'ready', fixture: 'controlled' };
  const target = { targetId: '/desktops', targetKind: 'page-route' as const, implementationRevision: 'build-1' };
  const contract: RenderMatrixContract = {
    schemaVersion: 1, reference: { schemaVersion: 1, featureId: 'feature', referenceId: 'approved', revision: 1, contentSha256: hash },
    cases: [{ caseId: 'ready-desktop', environment, target, evidenceKind: 'fixture', layout: 'side-by-side',
      controls: [{ name: 'Watch', enabled: true }], readyContentRequired: true }],
  };
  const observation: RenderMatrixObservation = {
    caseId: 'ready-desktop', environment, target, evidenceKind: 'fixture', capture: { path: 'actual.png', sha256: hash },
    geometry: { container: { x: 0, y: 0, width: 1440, height: 900, clientWidth: 1440, scrollWidth: 1440 },
      primary: { x: 0, y: 0, width: 1000, height: 600 }, secondary: { x: 1020, y: 0, width: 400, height: 700 } },
    controls: [{ name: 'Watch', visible: true, enabled: true }], readyContentVisible: true, placeholderVisible: false,
    connectivity: 'not-exercised', review: { referenceSha256: hash, captureSha256: hash, reviewer: 'unit-fixture',
      reviewedAt: '2026-09-08T00:00:00Z', verdict: 'pass', note: 'Synthetic validator input; not a browser review.' },
  };
  return { contract, observation };
}

describe('render matrix coverage and truthfulness', () => {
  it('accepts complete independently reviewed structure without claiming fixture connectivity', () => {
    const { contract, observation } = fixture();
    expect(evaluateRenderMatrix(contract, [observation]).satisfied).toBe(true);
  });
  it.each([
    ['stale-build', (r: RenderMatrixObservation) => { r.target = { ...r.target, implementationRevision: 'old' }; }],
    ['wrong-target', (r: RenderMatrixObservation) => { r.target = { ...r.target, targetId: '/cloud' }; }],
    ['wrong-environment', (r: RenderMatrixObservation) => { r.environment = { ...r.environment, theme: 'dark' }; }],
    ['wrong-evidence-kind', (r: RenderMatrixObservation) => { r.evidenceKind = 'real-service'; }],
    ['fixture-connectivity-claim', (r: RenderMatrixObservation) => { r.connectivity = 'connected'; r.connectivityEvidence = 'invented'; }],
    ['placeholder-is-not-ready', (r: RenderMatrixObservation) => { r.placeholderVisible = true; }],
    ['placeholder-is-not-ready', (r: RenderMatrixObservation) => { r.readyContentVisible = false; }],
    ['horizontal-overflow', (r: RenderMatrixObservation) => { r.geometry.container.scrollWidth = 1800; }],
    ['horizontal-overflow', (r: RenderMatrixObservation) => { r.geometry.primary.x = -50; }],
    ['wrong-layout', (r: RenderMatrixObservation) => { r.geometry.secondary.x = 0; }],
    ['control-unavailable:Watch', (r: RenderMatrixObservation) => { r.controls[0]!.enabled = false; }],
    ['control-unavailable:Watch', (r: RenderMatrixObservation) => { r.controls[0]!.visible = false; }],
    ['control-unavailable:Watch', (r: RenderMatrixObservation) => { r.controls = []; }],
    ['missing-side-by-side-review', (r: RenderMatrixObservation) => { delete r.review; }],
    ['stale-side-by-side-review', (r: RenderMatrixObservation) => { r.review!.referenceSha256 = 'b'.repeat(64); }],
    ['stale-side-by-side-review', (r: RenderMatrixObservation) => { r.capture.sha256 = 'b'.repeat(64); }],
    ['visual-review-failed', (r: RenderMatrixObservation) => { r.review!.verdict = 'fail'; }],
  ])('rejects %s', (reason, mutate) => {
    const { contract, observation } = fixture();
    mutate(observation);
    expect(evaluateRenderMatrix(contract, [observation]).failures).toContainEqual({ caseId: observation.caseId, reason });
  });
  it('a passing case cannot discharge a missing narrow state', () => {
    const { contract, observation } = fixture();
    contract.cases.push({ ...contract.cases[0]!, caseId: 'ready-narrow',
      environment: { ...observation.environment, viewport: { width: 390, height: 844 } }, layout: 'stacked' });
    expect(evaluateRenderMatrix(contract, [observation]).failures).toEqual([{ caseId: 'ready-narrow', reason: 'missing-case-evidence' }]);
  });
  it('checks stacked geometry and accepts scrolling below the viewport', () => {
    const { contract, observation } = fixture();
    contract.cases[0]!.layout = 'stacked';
    observation.geometry.secondary = { x: 0, y: 620, width: 1000, height: 700 };
    expect(evaluateRenderMatrix(contract, [observation]).satisfied).toBe(true);
    observation.geometry.secondary.y = 590;
    expect(evaluateRenderMatrix(contract, [observation]).failures).toContainEqual({ caseId: observation.caseId, reason: 'wrong-layout' });
  });
  it('refuses duplicate, empty and malformed records', () => {
    const { contract, observation } = fixture();
    expect(evaluateRenderMatrix(contract, [observation, observation]).failures).toContainEqual({ caseId: observation.caseId, reason: 'duplicate-case-evidence' });
    expect(evaluateRenderMatrix(contract, []).satisfied).toBe(false);
    expect(evaluateRenderMatrix({ ...contract, cases: [] }, []).satisfied).toBe(false);
    expect(evaluateRenderMatrix(contract, [{ ...observation, connectivity: 'probably-connected' }]).satisfied).toBe(false);
  });
  it('requires separately named real connectivity evidence even on a real-service capture', () => {
    const { contract, observation } = fixture();
    contract.cases[0]!.evidenceKind = 'real-service'; observation.evidenceKind = 'real-service';
    observation.connectivity = 'disconnected';
    expect(evaluateRenderMatrix(contract, [observation]).satisfied).toBe(true);
    observation.connectivity = 'connected';
    expect(evaluateRenderMatrix(contract, [observation]).failures).toContainEqual({ caseId: observation.caseId, reason: 'missing-connectivity-proof' });
  });
});
