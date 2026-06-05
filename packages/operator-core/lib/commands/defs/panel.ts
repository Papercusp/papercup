/**
 * panel.* — open / close / toggle the Operator panel.
 *
 * First reflexive command surface registered by PR 1. Exposed to:
 *   - Operator voice (ElevenLabs / OpenAI Realtime) — direct in-page tool
 *   - Oracle — via leader-bridge SSE for remote-tab dispatch
 *   - Palette + shortcut — direct in-page
 *
 * Handler is intentionally browser-only (`browser: 'required'`). When
 * invoked from a non-browser context (Pi subprocess), the registry
 * returns `{ ok: false, error.code: 'no-active-session' }` before this
 * code runs — see registry.ts.
 */
import { z } from 'zod';
import { register } from '../registry';
import { CommandError, type CommandDef } from '../types';

const PanelArg = z.object({
  panel: z
    .enum(['operator', 'oracle'])
    .default('operator')
    .describe('Which panel to act on. Defaults to operator.'),
});

type PanelArgT = z.infer<typeof PanelArg>;

async function setPanelOpen(panel: PanelArgT['panel'], open: boolean): Promise<{ panel: string; open: boolean }> {
  if (typeof window === 'undefined') {
    throw new CommandError({
      code: 'wrong-process',
      message: 'panel commands must run in the browser process',
      retryable: false,
    });
  }
  if (panel === 'operator') {
    const { setOperatorState } = await import('../../operator-shared-state');
    setOperatorState({ open });
    return { panel: 'operator', open };
  }
  // Oracle's panel state is owned elsewhere; for PR 1 we wire only operator.
  // PR 2 adds chat.open-pane which subsumes oracle.open. For now reject.
  throw new CommandError({
    code: 'not-implemented',
    message: 'oracle panel control not yet wired',
    retryable: false,
    hint: 'use chat.open-pane (PR 2) for oracle panel control',
  });
}

const panelOpen: CommandDef<PanelArgT, { panel: string; open: boolean }> = {
  id: 'panel.open',
  kind: 'command',
  description: 'Open a panel (operator | oracle).',
  schema: PanelArg,
  agents: ['operator', 'oracle', 'palette', 'shortcut'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  paletteEntry: { section: 'Papercup', title: 'Open Papercup panel', icon: '◉', keywords: 'operator panel show' },
  handler: ({ panel }) => setPanelOpen(panel, true),
};

const panelClose: CommandDef<PanelArgT, { panel: string; open: boolean }> = {
  id: 'panel.close',
  kind: 'command',
  description: 'Close a panel (operator | oracle).',
  schema: PanelArg,
  agents: ['operator', 'oracle', 'palette', 'shortcut'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  paletteEntry: { section: 'Papercup', title: 'Close Papercup panel', icon: '○', keywords: 'operator panel hide' },
  handler: ({ panel }) => setPanelOpen(panel, false),
};

const panelToggle: CommandDef<PanelArgT, { panel: string; open: boolean }> = {
  id: 'panel.toggle',
  kind: 'command',
  description: 'Toggle a panel open/closed (operator | oracle).',
  schema: PanelArg,
  agents: ['operator', 'oracle', 'palette', 'shortcut'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  paletteEntry: { section: 'Papercup', title: 'Toggle Papercup panel', icon: '◐', keywords: 'operator panel toggle' },
  handler: async ({ panel }) => {
    if (typeof window === 'undefined') {
      throw new CommandError({
        code: 'wrong-process',
        message: 'panel commands must run in the browser process',
        retryable: false,
      });
    }
    if (panel === 'operator') {
      const { broadcastState, sharedState } = await import('../../operator-shared-state');
      const next = !sharedState.open;
      broadcastState({ open: next });
      return { panel: 'operator', open: next };
    }
    throw new CommandError({
      code: 'not-implemented',
      message: 'oracle panel control not yet wired',
      retryable: false,
    });
  },
};

register(panelOpen);
register(panelClose);
register(panelToggle);
