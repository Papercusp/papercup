/**
 * mode:get / mode:set `ownerId` compatibility coverage (EI-20356723237531047).
 *
 * The coordination family's TARGETED-READ key drifted: coord:presence
 * canonicalised `owner` (declaring `ownerId`/`owners`/`ownerIds` as aliases) and
 * lists `agent` among its LEGACY keys, while mode:get/mode:set kept `agent`.
 * A caller carrying one shape across both reads paid a retry per hop.
 *
 * The failure mode these pin is SILENT, which is why they assert the resolved
 * target rather than an error: an undeclared `ownerId` is STRIPPED by zod's
 * default object parsing, so the pre-fix handler saw `args.agent === undefined`
 * and fell through to `ident.ownerId` — returning the CALLER's own modes under a
 * peer's id. A wrong answer that looks like a successful read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveAgentIdentity: vi.fn(),
  getModesWithLiveness: vi.fn(),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: h.resolveAgentIdentity,
}));

vi.mock('../../modes/liveness', () => ({
  getModesWithLiveness: h.getModesWithLiveness,
}));

import getTool from './get';
import setTool from './set';

const SELF = 'su-self-0000';
const PEER = 'su-peer-1111';

const runGet = (args: Record<string, unknown>) => getTool.handler(args as any, {} as any);

describe('mode:get ownerId compatibility alias', () => {
  beforeEach(() => {
    h.resolveAgentIdentity.mockReset().mockReturnValue({ ownerId: SELF, workspaceId: 'test-workspace' });
    h.getModesWithLiveness.mockReset().mockResolvedValue({ modes: [], sessionState: 'live', live: true });
  });

  it('resolves the target from `ownerId` when `agent` is absent', async () => {
    const res: any = await runGet({ ownerId: PEER });
    // The assertion that fails pre-fix: the alias was stripped, so the target
    // silently collapsed to SELF.
    expect(res.data.agent).toBe(PEER);
    expect(h.getModesWithLiveness).toHaveBeenCalledWith('test-workspace', PEER);
  });

  it('still resolves the canonical `agent` selector', async () => {
    const res: any = await runGet({ agent: PEER });
    expect(res.data.agent).toBe(PEER);
  });

  it('prefers the canonical `agent` when both are supplied', async () => {
    const res: any = await runGet({ agent: PEER, ownerId: 'su-other-2222' });
    expect(res.data.agent).toBe(PEER);
  });

  it('still defaults to the caller when neither is supplied', async () => {
    const res: any = await runGet({});
    expect(res.data.agent).toBe(SELF);
  });

  it('trims a padded alias value', async () => {
    const res: any = await runGet({ ownerId: `  ${PEER}  ` });
    expect(res.data.agent).toBe(PEER);
  });
});

describe('mode:get / mode:set declare the alias and its near-miss redirects', () => {
  // Declaration-level coverage: the alias must survive PARSING (an undeclared key
  // is stripped, which is the silent failure above), and the remaining near-miss
  // spellings must be redirected. argRedirects is uncounted by the prompt-weight
  // budget and paid only on the failure path, so it is the right home for them.
  it.each([
    ['mode:get', getTool, {} as Record<string, unknown>],
    ['mode:set', setTool, { mode: 'auto', reason: 'why' } as Record<string, unknown>],
  ])('%s accepts ownerId through its args schema', (_name, tool: any, base) => {
    const parsed = tool.args.parse({ ...base, ownerId: PEER });
    expect(parsed.ownerId).toBe(PEER);
  });

  it.each([
    ['mode:get', getTool],
    ['mode:set', setTool],
  ])('%s redirects the coord:presence spellings to `agent`', (_name, tool: any) => {
    const redirects = tool.guidance?.argRedirects ?? {};
    expect(redirects.owner).toBe('agent');
    expect(redirects.ownerIds).toBe('agent');
    expect(redirects.agentId).toBe('agent');
  });
});
