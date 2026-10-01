"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/app/harness/Button";
import { OperatorChat } from "@/app/_components/OperatorChat";
import type { ChatMessage } from "@/app/_components/chat/chat-types";
import { createVoiceOutputPlayback, isVoiceOutputMuted, setVoiceOutputMuted } from "@/app/_components/voice/voice-mode";
import type { LessonStep, StepStatus, TutorialScope } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";

/** Mounted only for the displayed authorized lesson. No product mutators or
 * controller dispatch are available to this chat or its model output. */
export function CloudTutorialAssistance({ scope, step, status, onShowStep }: {
  scope: TutorialScope; step: LessonStep; status: StepStatus; onShowStep?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(isVoiceOutputMuted);
  const [speechStatus, setSpeechStatus] = useState<'idle' | 'loading' | 'playing' | 'unavailable'>('idle');
  const pending = useRef<AbortController | null>(null);
  const helpTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSpoken = useRef(`${step.title}. ${step.brief} ${step.details}`);
  const requestContext = useRef({ expectedScope: scope, context: { step: step.id, status } });
  requestContext.current = { expectedScope: scope, context: { step: step.id, status } };
  const playback = useMemo(() => createVoiceOutputPlayback(async (question, engine, voiceId, signal) => {
    const response = await fetch('/api/hosted/browser/onboarding/tutorial-speech', { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      body: JSON.stringify({ ...requestContext.current, question, engine, ...(voiceId ? { voiceId } : {}) }) });
    if (!response.ok) throw new Error('speech_unavailable');
    return response.blob();
  }, setSpeechStatus), []);
  useEffect(() => {
    void playback.play(lastSpoken.current);
    const syncMute = () => { const next = isVoiceOutputMuted(); setMuted(next); if (next) playback.stop(); };
    window.addEventListener('papercusp:voiceOutputMutedChanged', syncMute);
    return () => { pending.current?.abort(); pending.current = null; if (helpTimeout.current) clearTimeout(helpTimeout.current); playback.stop(); window.removeEventListener('papercusp:voiceOutputMutedChanged', syncMute); };
  }, [playback]);
  const ask = async (question: string) => {
    if (pending.current || !question.trim()) return;
    const controller = new AbortController(); pending.current = controller;
    const timeout = setTimeout(() => { controller.abort(); if (pending.current === controller) { pending.current = null; setBusy(false); setError('AI help is taking too long. You can continue with the lesson instructions.'); } }, 15_000);
    helpTimeout.current = timeout;
    setBusy(true); setError(null); playback.stop();
    setMessages(current => [...current, { role: 'user', content: question }]);
    try {
      const response = await fetch('/api/hosted/browser/onboarding/tutorial-help', { method: 'POST',
        headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ ...requestContext.current, question }) });
      if (!response.ok) throw new Error('help_unavailable');
      const value: unknown = await response.json();
      if (controller.signal.aborted || pending.current !== controller) return;
      const answer = value && typeof value === 'object' && 'answer' in value && typeof value.answer === 'string' ? value.answer.trim().slice(0, 2000) : '';
      if (!answer) throw new Error('help_empty');
      setMessages(current => [...current, { role: 'assistant', content: answer }]);
      lastSpoken.current = answer; void playback.play(answer);
    } catch {
      if (!controller.signal.aborted) setError('AI help is unavailable. You can continue with the lesson instructions.');
    } finally {
      clearTimeout(timeout);
      if (helpTimeout.current === timeout) helpTimeout.current = null;
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  };
  return <section aria-label="Lesson help and speech">
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Button onClick={() => { setVoiceOutputMuted(!muted); if (muted) void playback.play(lastSpoken.current); }} aria-pressed={muted}>{muted ? 'Unmute guide' : 'Mute guide'}</Button>
      <Button onClick={playback.stop}>Stop speech</Button>
      <Button disabled={muted} onClick={() => void playback.play(lastSpoken.current)}>Replay speech</Button>
      {onShowStep && <Button onClick={onShowStep}>Show current step</Button>}
    </div>
    <p role="status" data-tutorial-speech-status={speechStatus}>{muted ? 'Guide speech is muted.' : speechStatus === 'loading' ? 'Preparing speech…' : speechStatus === 'playing' ? 'Speaking the lesson.' : speechStatus === 'unavailable' ? 'Speech could not be played. The text remains available; use Replay speech to try again.' : 'Speech is ready.'}</p>
    <p>Ask about this step. Keep credentials in the app’s connection form.</p>
    <div style={{ height: 320 }}><OperatorChat messages={messages} busy={busy} passive={false} onSend={question => void ask(question)}
      showQuickDraftPrompts={false} agentName="Lesson guide" emptyStateBody="Ask a question about the current lesson step." error={error} /></div>
  </section>;
}
