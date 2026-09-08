/** Translate native questions into the existing PUI card/response protocol.
 * The shared correlator validates the workspace and response exactly once. */
import { z } from 'zod';
import { cancelPendingCardsForRun, registerCard, resolveCardResponse } from '@papercusp/agent-mcp';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { SuSessionEventInput } from './su-session-host';
import type { RpcFrame } from './su-session-stdio-peer';

const record = (value: unknown): RpcFrame => value && typeof value === 'object' && !Array.isArray(value) ? value as RpcFrame : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export class SuNativeCards {
  private epoch = 0;
  constructor(private readonly workspaceId: string, private readonly runId: string,
    private readonly emit: (event: SuSessionEventInput) => void) {}

  cancel(): void { this.epoch++; cancelPendingCardsForRun(this.runId); }

  private async ask(turnId: string, prompt: string, choices?: string[]): Promise<string | null> {
    const answers = await this.askAnswers(turnId, prompt, choices?.map((label) => ({ label })));
    return answers?.[0] ?? null;
  }

  private async askAnswers(turnId: string, prompt: string,
    choices?: Array<{ label: string; description?: string }>, multiSelect = false, signal?: AbortSignal): Promise<string[] | null> {
    if (signal?.aborted) return null;
    const presentation = choices?.length
      ? { kind: multiSelect ? 'checkbox' as const : 'radio' as const,
        options: choices.map((choice, index) => ({ id: String(index), ...choice })) }
      : { kind: 'text' as const };
    const dataSchema = choices?.length
      ? z.object({ picks: z.array(z.string()).min(1).max(multiSelect ? choices.length : 1).refine((picks) => presentation.kind !== 'text'
        && new Set(picks).size === picks.length && picks.every((pick) => presentation.options.some((option) => option.id === pick)), 'Choose displayed options') })
      : z.object({ value: z.string().min(1) });
    const card = registerCard({ workspaceId: this.workspaceId, runId: this.runId,
      spec: { prompt, dataSchema, presentation, allowDecline: true } });
    const cancel = () => { resolveCardResponse({ correlationId: card.correlationId, action: 'cancel', expectedWorkspaceId: this.workspaceId }); };
    signal?.addEventListener('abort', cancel, { once: true });
    this.emit({ type: 'card', phase: 'opened', turnId, card: {
      correlationId: card.correlationId, createdAt: Date.now(), prompt, fallbackText: prompt,
      presentation, allowDecline: true,
    } });
    const response = await card.result.finally(() => signal?.removeEventListener('abort', cancel));
    this.emit({ type: 'card', phase: 'closed', turnId, correlationId: card.correlationId,
      resolution: response.action === 'submit' ? 'submitted' : response.action === 'decline' ? 'declined' : 'cancelled' });
    if (response.action !== 'submit') return null;
    return 'picks' in response.payload ? response.payload.picks.map((pick) => choices![Number(pick)].label) : [response.payload.value];
  }

  async handleClaude(toolName: string, input: Record<string, unknown>, turnId: string,
    options: Parameters<CanUseTool>[2]): ReturnType<CanUseTool> {
    const epoch = this.epoch;
    const deny = (message = 'The PUI response was declined or cancelled') => ({ behavior: 'deny' as const, message });
    try {
      if (options.signal.aborted) return deny();
      if (toolName !== 'AskUserQuestion') {
        const prompt = [options.title || `Allow ${toolName}?`, options.description, options.decisionReason,
          JSON.stringify(input, null, 2)].filter(Boolean).join('\n');
        const choice = await this.askAnswers(turnId, prompt, [{ label: 'Approve' }, { label: 'Decline' }], false, options.signal);
        return epoch === this.epoch && !options.signal.aborted && choice?.[0] === 'Approve'
          ? { behavior: 'allow', updatedInput: input } : deny();
      }
      const questions = z.array(z.object({
        question: z.string().min(1), multiSelect: z.boolean().optional(),
        options: z.array(z.object({ label: z.string().min(1), description: z.string().optional(), preview: z.string().optional() })).min(1),
      })).min(1).max(4).parse(input.questions);
      if (new Set(questions.map((question) => question.question)).size !== questions.length) {
        throw new Error('Claude questions must have distinct prompts');
      }
      const answers: Record<string, string> = {};
      for (const question of questions) {
        if (epoch !== this.epoch || options.signal.aborted) return deny();
        let other = 'Type a different answer';
        while (question.options.some((option) => option.label === other)) other += '…';
        const choices = question.options.map((option) => ({ label: option.label,
          description: [option.description, option.preview].filter(Boolean).join('\n') }));
        const picks = await this.askAnswers(turnId, question.question, [...choices, { label: other }], question.multiSelect, options.signal);
        if (!picks || epoch !== this.epoch || options.signal.aborted) return deny();
        const selected = picks.filter((pick) => pick !== other);
        if (picks.includes(other)) {
          const custom = await this.askAnswers(turnId, question.question, undefined, false, options.signal);
          if (!custom || epoch !== this.epoch || options.signal.aborted) return deny();
          selected.push(...custom);
        }
        answers[question.question] = selected.join(', ');
      }
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', scope: 'command', code: 'native_question_failed', message, recoverable: true });
      return deny(message);
    }
  }

  /** True means this is a supported native request, now waiting for PUI input. */
  handle(backend: 'codex' | 'omp', frame: RpcFrame, turnId: string, reply: (frame: RpcFrame) => void): boolean {
    const method = text(frame.method), params = record(frame.params), epoch = this.epoch;
    let run: (() => Promise<RpcFrame>) | undefined;
    if (backend === 'codex' && frame.id != null) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
        run = async () => {
          const prompt = [text(params.reason) || 'Approve this tool action?', text(params.command),
            params.cwd ? `Directory: ${text(params.cwd)}` : ''].filter(Boolean).join('\n');
          const choice = await this.ask(turnId, prompt, ['Approve', 'Decline']);
          return { id: frame.id, result: { decision: choice === 'Approve' ? 'accept' : choice === 'Decline' ? 'decline' : 'cancel' } };
        };
      } else if (method === 'item/tool/requestUserInput') {
        run = async () => {
          const answers: Record<string, { answers: string[] }> = {};
          for (const value of Array.isArray(params.questions) ? params.questions : []) {
            if (epoch !== this.epoch) break;
            const question = record(value);
            if (!text(question.id) || !text(question.question) || question.isSecret === true) {
              throw new Error('This native question requires a form PUI cannot safely display');
            }
            const choices = Array.isArray(question.options) ? question.options.map((option) => text(record(option).label)) : undefined;
            const answer = await this.ask(turnId, text(question.question), choices);
            if (answer === null) break;
            answers[text(question.id)] = { answers: [answer] };
          }
          return { id: frame.id, result: { answers } };
        };
      }
    } else if (backend === 'omp' && frame.type === 'extension_ui_request' && typeof frame.id === 'string') {
      if (method === 'confirm') run = async () => ({ type: 'extension_ui_response', id: frame.id,
        confirmed: await this.ask(turnId, [text(frame.title), text(frame.message)].filter(Boolean).join('\n'), ['Confirm', 'Decline']) === 'Confirm' });
      else if (method === 'select' || method === 'input' || method === 'editor') run = async () => {
        const choices = method === 'select' && Array.isArray(frame.options) ? frame.options.map(text) : undefined;
        const value = await this.ask(turnId, text(frame.title) || 'Your response', choices);
        return { type: 'extension_ui_response', id: frame.id, ...(value === null ? { cancelled: true } : { value }) };
      };
      else if (method === 'cancel') { this.cancel(); return true; }
    }
    if (!run) return false;
    void run().then(reply).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', scope: 'command', code: 'native_question_failed', message, recoverable: true });
      reply(backend === 'codex' ? { id: frame.id, error: { code: -32602, message } }
        : { type: 'extension_ui_response', id: frame.id, cancelled: true });
    });
    return true;
  }
}
