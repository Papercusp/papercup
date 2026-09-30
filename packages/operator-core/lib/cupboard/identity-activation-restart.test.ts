/**
 * agent-economy-flywheel P-016 (D-012): the restart door never returns a render
 * that carries an unfunded priced identity, because its callers keep the inherited
 * render when a rebuild throws.
 */
import { describe, expect, it } from 'vitest';
import type { RebuildSuLaunchArtifactInput, RebuiltSuLaunchArtifact } from '../su-persona-render';
import type { IdentityActivationDecision, IdentityActivationRefusedLayer } from './identity-activation-gate';
import { isIdentityActivationRefusedError } from './identity-activation-gate';
import type { IdentityActivationRequest } from './identity-activation-gate-io';
import { rebuildSuLaunchArtifactFunded } from './identity-activation-restart';

const PAID = 'identity:acme-reviewer';
const FREE = 'domain:papercusp-engineer';

const input = {
  ownerId: 'su-test',
  operatorBaseUrl: 'http://127.0.0.1:3070',
  record: { workspaceId: 'ws-test', stack: [FREE, PAID] },
  modeSection: '',
} as unknown as RebuildSuLaunchArtifactInput;

function refusal(layerRef: string): IdentityActivationDecision {
  const refused: IdentityActivationRefusedLayer = {
    layerRef,
    skuRef: 'identity-release:acme-reviewer@1.0.0',
    code: 'identity-activation-unfunded',
    detail: 'no funded channel or prepaid credits',
  };
  return { ok: false, code: refused.code, detail: refused.detail, refused: [refused], charged: [] };
}

/** A fake rebuild whose artifact stack is exactly the stack it was asked for. */
function harness(admitFor: (stack: readonly string[]) => IdentityActivationDecision) {
  const rebuilds: (readonly string[])[] = [];
  const admits: IdentityActivationRequest[] = [];
  return {
    rebuilds,
    admits,
    deps: {
      rebuild: async (req: RebuildSuLaunchArtifactInput) => {
        const stack = [...(req.stack ?? req.record.stack ?? [])];
        rebuilds.push(stack);
        return { spec: { cwd: '/repo' }, artifact: { stack }, promptText: stack.join('\n') } as unknown as RebuiltSuLaunchArtifact;
      },
      admit: async (request: IdentityActivationRequest) => {
        admits.push(request);
        return admitFor(request.stack);
      },
    },
  };
}

describe('rebuildSuLaunchArtifactFunded', () => {
  it('returns the rebuilt artifact untouched when every priced layer is funded', async () => {
    const h = harness(() => ({ ok: true, charged: [] }));
    const out = await rebuildSuLaunchArtifactFunded(input, h.deps);
    expect(out.identityActivationRefusal).toBeNull();
    expect(out.removedLayerRefs).toEqual([]);
    expect(h.rebuilds).toEqual([[FREE, PAID]]);
    expect(h.admits[0]).toEqual({ stack: [FREE, PAID], repoDir: '/repo', workspaceId: 'ws-test' });
  });

  it('drops the refused priced layer from the render and reports the refusal', async () => {
    const h = harness((stack) => (stack.includes(PAID) ? refusal(PAID) : { ok: true, charged: [] }));
    const out = await rebuildSuLaunchArtifactFunded(input, h.deps);
    expect(out.rebuilt.artifact.stack).toEqual([FREE]);
    expect(out.rebuilt.promptText).not.toContain(PAID);
    expect(out.removedLayerRefs).toEqual([PAID]);
    expect(out.identityActivationRefusal?.code).toBe('identity-activation-unfunded');
    expect(h.rebuilds).toEqual([[FREE, PAID], [FREE]]);
  });

  it('matches refused refs whatever whitespace the persisted stack carries', async () => {
    const spaced = { ...input, record: { ...input.record, stack: [FREE, 'identity: acme-reviewer'] } } as RebuildSuLaunchArtifactInput;
    const h = harness((stack) => (stack.some((ref) => ref.includes('acme')) ? refusal(PAID) : { ok: true, charged: [] }));
    const out = await rebuildSuLaunchArtifactFunded(spaced, h.deps);
    expect(out.removedLayerRefs).toEqual(['identity: acme-reviewer']);
    expect(out.rebuilt.artifact.stack).toEqual([FREE]);
  });

  it('throws the typed refusal when removing stack entries cannot cure it', async () => {
    const h = harness(() => refusal('identity:derived-only'));
    const error = await rebuildSuLaunchArtifactFunded(input, h.deps).catch((e: unknown) => e);
    expect(isIdentityActivationRefusedError(error)).toBe(true);
    expect(h.rebuilds).toHaveLength(1);
  });

  it('throws the typed refusal when the degraded stack is still refused', async () => {
    const h = harness((stack) => (stack.includes(PAID) ? refusal(PAID) : refusal(FREE)));
    const error = await rebuildSuLaunchArtifactFunded(
      { ...input, record: { ...input.record, stack: [PAID] } } as RebuildSuLaunchArtifactInput,
      { ...h.deps, admit: async (request) => (request.stack.length ? refusal(PAID) : refusal('identity:elsewhere')) },
    ).catch((e: unknown) => e);
    expect(isIdentityActivationRefusedError(error)).toBe(true);
  });
});
