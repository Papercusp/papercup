/**
 * resume-transcript-preflight.ts — "is there anything a resume/fork/convert can
 * actually OPEN?", shared by every consult launch path.
 *
 * Extracted from revive-responder.ts (plan consult-expert-routing-2026-09-22
 * P-003) when the fork/convert dispatcher became a second caller. It is a
 * FAIL-CLOSED preflight, and both callers depend on that: `adv_sessions` is only
 * a launch ledger, so an ended row can outlive both its native transcript and its
 * archive copy, and launching against one produces a 502-producing headless shell
 * rather than a responder.
 *
 * The on-disk check comes FIRST because a healthy transcript need not have an
 * archive row. If the file was retired, `rematerializeTranscript` restores from
 * the canonical archive and the check re-resolves beneath the exact restored root.
 */
import type { ResumeTarget } from '../agent-launch-core';

export interface ConsultResumeTranscriptCheck {
  available: boolean;
  detail: string;
  /**
   * The exact native transcript resolved on disk or restored from the archive.
   * Claude forks analyze its tail; conversions validate it with the maintained
   * session-port adapter before spending a launch (WI-10007960).
   */
  transcriptPath?: string;
}

export async function checkConsultResumeTranscript(
  target: ResumeTarget,
): Promise<ConsultResumeTranscriptCheck> {
  try {
    const agent = (target.agent ?? '').toLowerCase();
    if (agent === 'claude' || agent === 'claude-code') {
      if (!target.sessionId) {
        return { available: false, detail: 'Claude resume target has no native session id' };
      }
      const { findSessionTranscript } = await import('../claude-sessions');
      const existing = await findSessionTranscript(target.sessionId, { owner: target.ownerId });
      if (existing) {
        return { available: true, detail: `native transcript found at ${existing}`, transcriptPath: existing };
      }
      const { rematerializeTranscript } = await import('../session-transcript-remat');
      const restored = await rematerializeTranscript({
        kind: 'claude',
        sessionId: target.sessionId,
        ...(target.ownerId ? { owner: target.ownerId } : {}),
      });
      return restored.path
        ? {
            available: true,
            detail: `native transcript restored from archive at ${restored.path}`,
            transcriptPath: restored.path,
          }
        : {
            available: false,
            detail: `native transcript unavailable (${restored.reason})`,
          };
    }

    if (agent === 'codex') {
      const [{ findCodexRolloutPath, findCodexRolloutPathByUuid }, { codexHomeForSessionKey }] = await Promise.all([
        import('../session-transcript-resolvers'),
        import('@papercusp/orchestrator/session-launch-dirs'),
      ]);
      const codexHome = codexHomeForSessionKey(target.advSessionId);
      const existing = target.sessionId
        ? await findCodexRolloutPathByUuid(target.sessionId, { homeOverride: codexHome })
        : await findCodexRolloutPath(target.advSessionId, { homeOverride: codexHome });
      if (existing) {
        return { available: true, detail: `Codex transcript found at ${existing}`, transcriptPath: existing };
      }
      const { rematerializeTranscript } = await import('../session-transcript-remat');
      const restored = target.sessionId
        ? await rematerializeTranscript({ kind: 'codex-rollout', rolloutId: target.sessionId })
        : await rematerializeTranscript({ kind: 'codex-session-key', sessionKey: String(target.advSessionId) });
      return restored.path
        ? { available: true, detail: `Codex transcript restored from archive at ${restored.path}`, transcriptPath: restored.path }
        : { available: false, detail: `Codex transcript unavailable (${restored.reason})` };
    }

    if (agent === 'omp' || agent === 'pi') {
      if (!target.ompThreadId) {
        return { available: false, detail: 'OMP resume target has no thread id' };
      }
      const { findOmpSessionPath } = await import('../session-transcript-resolvers');
      const existing = await findOmpSessionPath(target.ompThreadId, { sessionKey: target.advSessionId });
      if (existing) {
        return { available: true, detail: `OMP transcript found at ${existing}`, transcriptPath: existing };
      }
      const { rematerializeTranscript } = await import('../session-transcript-remat');
      const restored = await rematerializeTranscript({
        kind: 'omp',
        threadId: target.ompThreadId,
        sessionKey: target.advSessionId,
      });
      return restored.path
        ? { available: true, detail: `OMP transcript restored from archive at ${restored.path}`, transcriptPath: restored.path }
        : { available: false, detail: `OMP transcript unavailable (${restored.reason})` };
    }

    return { available: false, detail: `unsupported resume backend ${target.agent ?? '(unknown)'}` };
  } catch (e) {
    return {
      available: false,
      detail: `transcript availability preflight failed: ${(e as Error)?.message ?? String(e)}`,
    };
  }
}

/** Conversion has stricter source requirements than a native fork. Reuse the
 * port's bounded, fixed-high-water reader and exact backend adapter; never repair
 * or rewrite a source transcript to make it eligible. Inspection reacquires and
 * validates the source again at launch, so this preflight grants no authority. */
export async function checkConsultSessionPortTranscript(
  target: ResumeTarget,
  transcript: ConsultResumeTranscriptCheck,
): Promise<ConsultResumeTranscriptCheck> {
  if (target.role != null) {
    return { available: false, detail: 'session-port protocol v1 requires a plain tracked SU source' };
  }
  const agent = target.agent === 'claude-code' ? 'claude' : target.agent;
  const nativeId = agent === 'omp' ? target.ompThreadId ?? target.sessionId : target.sessionId;
  if (!['claude', 'codex', 'omp'].includes(agent ?? '') || !nativeId || !transcript.available || !transcript.transcriptPath) {
    return { available: false, detail: 'session-port preflight requires an exact supported native transcript' };
  }
  try {
    const [{ readStableLiveJsonl }, { adaptNativeSessionJsonl }] = await Promise.all([
      import('../session-port/source'),
      import('../session-port/native-adapter'),
    ]);
    const stable = await readStableLiveJsonl(transcript.transcriptPath);
    adaptNativeSessionJsonl(agent as 'claude' | 'codex' | 'omp', stable.bytes.toString('utf8'), nativeId);
    return { available: true, detail: 'exact source passed session-port transcript validation' };
  } catch (e) {
    return { available: false, detail: `session-port transcript preflight refused: ${(e as Error)?.message ?? String(e)}` };
  }
}
