"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/app/harness/Button";
import NewSessionLauncher from "@/app/adv/sessions/NewSessionLauncher";
import { useAgentThinkingStream, groupEntriesIntoTurns, type TimelineEntry } from "@/app/harness/AgentThinkingStream";
import { OperatorChat } from "@/app/_components/OperatorChat";
import { sessionTimelineToChatMessages } from "@/app/_components/chat/session-transcript-mapping";
import { sendToSessionOwner, useOwnerSessionChat } from "@/app/_components/chat/use-owner-session-chat";
import { CLOUD_TUTORIAL_TASK, type ProductObservation, type TutorialScope } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";

type RequestReceipt = { id: string; prompt: string; sentAt: number };
export type TutorialSessionObservation = Pick<ProductObservation, "agent" | "task" | "attempt">;

/** Match a human-submitted request in THIS owner's transcript. Commentary,
 * another request's answer, and legacy results without an outcome never certify success. */
export function correlatedTutorialTask(entries: readonly TimelineEntry[], request: RequestReceipt | null) {
  if (!request) return null;
  const turn = groupEntriesIntoTurns(entries).find(candidate => candidate.prompt?.text?.includes(request.prompt));
  const terminal = turn?.entries.filter(entry => entry.kind === "result" && entry.outcome).at(-1);
  const hasAnswer = turn?.entries.some(entry => (entry.kind === "text" || entry.kind === "result") && entry.text?.trim());
  return { entries: turn ? [turn.prompt!, ...turn.entries] : [],
    status: terminal?.outcome === "failed" ? "failed" as const : terminal?.outcome === "succeeded" && terminal.ts && hasAnswer ? "succeeded" as const : "pending" as const,
    resultId: terminal?.outcome === "succeeded" && terminal.ts && hasAnswer ? `${request.id}:${terminal.ts}` : undefined };
}

/** Real product controls, separate from Guide actions. Reuses the maintained
 * launcher, owner resolver, message transport, stream parser and chat renderer. */
export function CloudTutorialSession({ scope, onObservation, onInspect }: {
  scope: TutorialScope; onObservation: (value: TutorialSessionObservation) => void;
  onInspect: (task: NonNullable<ProductObservation["task"]>) => void;
}) {
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [resolution, setResolution] = useState(0);
  return <section aria-label="First agent workspace session">
    <div data-tutorial-target="cloud-agent" tabIndex={-1}>
      <h3>Run an agent on this workspace</h3>
      <p>Choose an available model and account. Model usage may incur costs. Review your provider account before launching.</p>
      <NewSessionLauncher initialPosture="interactive" onLaunched={id => { setOwnerId(id); setResolution(value => value + 1); }} />
      {ownerId ? <p role="status">Waiting for your launched session to become available.</p> : <p>The lesson waits for the session you explicitly launch here.</p>}
    </div>
    {ownerId && <SessionConversation key={`${ownerId}:${resolution}`} ownerId={ownerId} scope={scope}
      onObservation={onObservation} onInspect={onInspect} onRetry={() => setResolution(value => value + 1)} />}
  </section>;
}

function SessionConversation({ ownerId, scope, onObservation, onInspect, onRetry }: {
  ownerId: string; scope: TutorialScope; onObservation: (value: TutorialSessionObservation) => void;
  onInspect: (task: NonNullable<ProductObservation["task"]>) => void; onRetry: () => void;
}) {
  const chat = useOwnerSessionChat(ownerId);
  return <>
    {chat.resolveError && <p role="alert">Your session could not be read. Check your account and workspace access, then check again.</p>}
    {!chat.streamUrl && <><p role="status">{chat.resolving ? "Checking your session…" : "The session has not appeared yet. Check its launch receipt and try again."}</p><Button onClick={onRetry}>Check session again</Button></>}
    {chat.streamUrl && chat.resolved?.active !== false && <SessionTask streamUrl={chat.streamUrl} ownerId={ownerId} scope={scope} onObservation={onObservation} onInspect={onInspect} />}
    {chat.resolved?.active === false && <p role="alert">This session ended. Launch a new session to continue.</p>}
  </>;
}

function SessionTask({ streamUrl, ownerId, scope, onObservation, onInspect }: {
  streamUrl: string; ownerId: string; scope: TutorialScope;
  onObservation: (value: TutorialSessionObservation) => void; onInspect: (task: NonNullable<ProductObservation["task"]>) => void;
}) {
  const stream = useAgentThinkingStream("", "", "", streamUrl);
  const [request, setRequest] = useState<RequestReceipt | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delayed, setDelayed] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => () => { ++generation.current; }, []);
  const correlation = useMemo(() => correlatedTutorialTask(stream.events, request), [stream.events, request]);
  const task = useMemo<NonNullable<ProductObservation["task"]> | undefined>(() => request ? {
    id: request.id, sessionId: ownerId, sampleTask: true, submittedByUser: true,
    status: correlation?.status ?? "pending", ...(correlation?.resultId ? { resultId: correlation.resultId } : {}),
  } : undefined, [request, ownerId, correlation]);
  useEffect(() => {
    onObservation({ agent: { id: ownerId, workspaceId: scope.workspaceId, launchedByUser: true, available: stream.status === "live" || stream.status === "done" },
      ...(task ? { task } : {}),
      ...(error || delayed || stream.status === "error" ? { attempt: { step: task ? "task" as const : "agent" as const, status: error || stream.status === "error" ? "failed" as const : "delayed" as const } } : {}) });
  }, [ownerId, scope.workspaceId, stream.status, task, error, delayed, onObservation]);
  useEffect(() => {
    setDelayed(false);
    if (!request || task?.status !== "pending") return;
    const timer = setTimeout(() => setDelayed(true), 45_000);
    return () => clearTimeout(timer);
  }, [request, task?.status]);
  const submit = useCallback(async () => {
    if (busy.current) return;
    busy.current = true; setSending(true); setError(null);
    const epoch = generation.current;
    const id = crypto.randomUUID();
    const receipt = { id, prompt: `${CLOUD_TUTORIAL_TASK}\n\nLesson request: ${id}`, sentAt: Date.now() };
    setRequest(receipt);
    try { await sendToSessionOwner(ownerId, receipt.prompt); }
    catch { if (epoch === generation.current) setError("Delivery could not be confirmed. Check this session's transcript before explicitly retrying; an accepted message may still finish."); }
    finally { if (epoch === generation.current) { busy.current = false; setSending(false); } }
  }, [ownerId]);
  return <>
    <div data-tutorial-target="cloud-task" tabIndex={-1}>
      <h3>Send a small read-only task</h3><p>{CLOUD_TUTORIAL_TASK}</p>
      <Button disabled={sending || stream.status === "connecting" || (task?.status === "pending" && !error && !delayed)} onClick={() => void submit()}>
        {request ? "Send sample task again" : "Send sample task"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {delayed && <p role="status">This task is taking longer than expected. Inspect its transcript and account status before retrying.</p>}
      {task?.status === "failed" && <p role="alert">The task did not finish successfully. Review the session's error, then explicitly send it again.</p>}
    </div>
    <div data-tutorial-target="cloud-result" tabIndex={-1}>
      <h3>Inspect your task's answer</h3>
      <div style={{ height: 360, minHeight: 240 }}><OperatorChat messages={sessionTimelineToChatMessages(correlation?.entries ?? [])} busy={task?.status === "pending"} passive
        onSend={() => {}} composerDisabled composerDisabledMessage="Use Send sample task above to submit the lesson task."
        showQuickDraftPrompts={false} agentName="Your workspace agent" emptyStateBody="The correlated answer will appear here after your sample task." /></div>
      <Button disabled={task?.status !== "succeeded" || !task.resultId} onClick={() => { if (task?.status === "succeeded" && task.resultId) onInspect(task); }}>I've inspected this answer</Button>
    </div>
  </>;
}
