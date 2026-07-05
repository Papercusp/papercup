/**
 * mode:set — enter/exit an official session mode, for yourself OR a peer
 * (modes-and-intake-ux-2026-07-05 P-006; D-003 guardrails, D-006 axes).
 *
 * Modes are first-class data (harness_shared.agent_modes), not prompt prose:
 * peers see your modes in coord:presence / coord:orient, and every transition
 * is audited (agent_mode_changes). Semantics enforced by the store:
 *   - AXES: same-axis modes auto-switch (setting drain clears ideate — both
 *     recorded); cross-axis modes stack (auto + ideate is the canonical pair).
 *   - OWNER-STICKY (D-003): a mode armed with ownerDirected (the human owner
 *     explicitly instructed it) cannot be overridden by a PEER — the attempt
 *     is refused and DOWNGRADED to a request message the target/owner sees.
 *   - PEER-SET delivery: reason is mandatory; the target gets a coord message
 *     carrying the reason AND the mode's full contract, and the change takes
 *     effect at ITS next turn boundary (coord:orient re-injects active
 *     contracts each wake — nothing changes mid-turn).
 *
 * On a SELF-set the response carries the full mode contract (P-008: the
 * always-present prompt holds only the one-line index; the contract loads at
 * activation — read it NOW, it is binding while the mode is on).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import { modeById, MODES } from '../../modes/registry';
import { setMode } from '../../modes/store';

const MODE_IDS = MODES.map((m) => m.id);

export default defineTool({
  name: 'mode:set',
  profile: 'engineer',
  description:
    'Enter/exit an official session mode (auto | cold-auto | ideate | drain | grade) for yourself or a peer. ' +
    '{ mode, reason, enabled?, agent?, ownerDirected? }. Same-axis modes AUTO-SWITCH (result carries switchedFrom); ' +
    'cross-axis modes stack. Peer-set: reason is delivered to the target with the mode contract; an owner-directed ' +
    'incumbent REFUSES a peer override (stickyConflict:true — downgraded to a request message). Self-set returns the ' +
    'full binding contract — read it. Audited in agent_mode_changes.',
  guidance: {
    when:
      'The user (or your judgment under AUTO) puts the session in a mode — "auto mode", "ideate", "drain the backlog", ' +
      '"grade X" — or you need to redirect a peer\'s operating posture with a reason they will see. Pass ' +
      'ownerDirected:true ONLY when the human owner explicitly instructed this mode — it arms the sticky guard peers cannot override.',
    notWhen:
      'Transient per-task instructions that end with the turn — modes are standing session state. Never mode:set a peer ' +
      'to dodge coordination (the reason is delivered and audited); never pass ownerDirected on your own initiative.',
    chaining:
      'mode:set → read the returned contract (self) · coord:orient re-injects active contracts each wake · mode:get { agent } ' +
      'to inspect anyone · exiting: mode:set { mode, enabled:false, reason }. A stickyConflict result means the incumbent is ' +
      'owner-directed: your reason was delivered as a REQUEST — do not retry, wait for the target/owner.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    mode: z.enum(MODE_IDS as [string, ...string[]]).describe('the mode id'),
    reason: z.string().min(1).max(2000).describe('why — MANDATORY; delivered to a peer target verbatim'),
    enabled: z.boolean().optional().describe('default true; false ⇒ exit the mode'),
    agent: z.string().max(120).optional().describe('target ownerId (exact, e.g. su-…); omit for yourself'),
    ownerDirected: z
      .boolean()
      .optional()
      .describe('the human owner explicitly instructed this mode (self-set only) — arms the owner-sticky guard'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const target = args.agent?.trim() || ident.ownerId;
    const isSelf = target === ident.ownerId;
    const enabled = args.enabled !== false;
    const def = modeById(args.mode);
    if (!def) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `unknown mode '${args.mode}'` }) }] };

    const res = await setMode({
      workspaceId: ident.workspaceId ?? 'default',
      ownerId: target,
      modeId: def.id,
      enabled,
      reason: args.reason,
      setBy: ident.ownerId,
      ownerDirected: args.ownerDirected,
    });

    // Peer-set: deliver the why (+ contract on enable) — or the downgraded
    // REQUEST when the owner-sticky guard refused the write. Fail-soft: a
    // delivery hiccup never rolls back an applied mode change.
    if (!isSelf && (res.ok || res.stickyConflict)) {
      const verb = !res.ok ? 'REQUESTS (owner-sticky refused)' : enabled ? 'set you to' : 'cleared';
      try {
        await sendMessage(ident, {
          to: [target],
          summary: `mode: ${ident.ownerId} ${verb} '${def.id}' — ${args.reason.slice(0, 140)}`,
          body:
            `${ident.ownerId} ${verb} mode '${def.id}' (${def.axis} axis).\nReason: ${args.reason}` +
            (res.ok && res.switchedFrom ? `\nAuto-switched from same-axis mode '${res.switchedFrom}'.` : '') +
            (res.ok && enabled ? `\nEffective from your NEXT turn. Binding contract:\n\n${def.contract}` : ''),
          extra: { mode_change: { mode: def.id, enabled, applied: res.ok === true, stickyConflict: res.stickyConflict === true, by: ident.ownerId } },
        });
      } catch { /* fail-soft */ }
    }

    const payload: Record<string, unknown> = {
      ok: res.ok,
      mode: def.id,
      axis: def.axis,
      target,
      enabled,
      noop: res.noop ?? false,
      switchedFrom: res.switchedFrom ?? null,
      stickyConflict: res.stickyConflict ?? false,
      ...(res.stickyConflict ? { note: 'incumbent is owner-directed; your reason was delivered as a REQUEST — do not retry' } : {}),
      ...(res.ok && enabled && isSelf ? { contract: def.contract } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
