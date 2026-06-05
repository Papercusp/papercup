import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { enableVoiceAgent, voiceAgentEnabled, voiceAgentSay } from '../../voice-node/agent-peer';

export default defineTool({
  name: 'voice:agent',
  profile: 'engineer',
  description: 'Voice agent peer: enable/disable channel listening (STT), or speak text into the active channel (TTS).',
  capability: 'operator:write',
  guidance: {
    when: `Toggle the agent's ears in the active voice channel ({op:'enable'|'disable'}) or speak into it ({op:'say', text}).`,
    notWhen: `Joining/leaving the channel itself is \`voice:join\`/\`voice:leave\`; this controls only the agent's listen/speak behaviors on top.`,
    chaining: `voice:join → voice:agent {op:'enable'} → transcripts flow to subscribers → voice:agent {op:'say', text:'…'} to respond.`,
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect'],
  rolesQuota: { architect: { perRun: 50 }, operator: { perRun: 200 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('enable') }),
    z.object({ op: z.literal('disable') }),
    z.object({ op: z.literal('status') }),
    z.object({ op: z.literal('say'), text: z.string().min(1).max(4000) }),
  ]),
  async handler(args) {
    if (args.op === 'say') {
      const frames = await voiceAgentSay(args.text);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: frames > 0, frames }) }] };
    }
    if (args.op === 'enable') enableVoiceAgent(true);
    if (args.op === 'disable') enableVoiceAgent(false);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, enabled: voiceAgentEnabled() }) }] };
  },
});
