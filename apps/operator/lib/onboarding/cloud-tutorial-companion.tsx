"use client";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/app/harness/Button";
import type { TutorialStepId } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import type { WorkspaceHostConnectionRow, WorkspaceHostControlRow } from "@/app/cloud-workspaces/workspace-view-model";
import type { TutorialSessionObservation } from "./cloud-tutorial-session";
import { CloudTutorialGuide } from "./cloud-tutorial-guide";
import { useCloudTutorialProgress } from "./use-cloud-tutorial-progress";
const CloudTutorialSession = lazy(async () => ({ default: (await import("./cloud-tutorial-session")).CloudTutorialSession }));

export function CloudTutorialCompanion({ selectionKey, connection, workspace, boundWorkspaceId, configurationValid, configurationReviewed, controlLoading, controlError, onCheckAgain, onShowStep }: {
  selectionKey: string; connection: WorkspaceHostConnectionRow | null;
  workspace: WorkspaceHostControlRow | null; boundWorkspaceId: string | null;
  configurationValid: boolean; configurationReviewed: boolean;
  controlLoading: boolean; controlError: Error | null;
  onCheckAgain: () => void; onShowStep: (step: TutorialStepId) => void;
}) {
  const { state, dispatch, loading, notice, retry } = useCloudTutorialProgress(selectionKey);
  const revision = useRef(0);
  const [session, setSession] = useState<{ selectionKey: string; value: TutorialSessionObservation } | null>(null);
  const onSessionObservation = useCallback((value: TutorialSessionObservation) => setSession({ selectionKey, value }), [selectionKey]);
  const workspaceReady = Boolean(state && workspace?.observedState === "running" && workspace.desiredState === "running" && workspace.health?.status === "healthy" && boundWorkspaceId === state.scope.workspaceId);
  useEffect(() => {
    if (!state || controlLoading) return;
    dispatch({ type: "observe", observation: { scope: state.scope, revision: ++revision.current,
      access: controlError ? "denied" : "allowed",
      ...(connection?.target === "gcp" ? { connection: { id: connection.id, provider: "gcp", validated: connection.status === "connected" } } : {}),
      ...(connection ? { configuration: { connectionId: connection.id, valid: configurationValid, costReviewed: configurationReviewed } } : {}),
      ...(workspace && state ? { workspace: { id: state.scope.workspaceId, connectionId: workspace.connectionId, healthy: workspaceReady } } : {}),
      ...(session?.selectionKey === selectionKey && workspaceReady ? session.value : {}),
      ...(workspace && !workspaceReady ? { attempt: { step: "workspace", status: workspace.operation?.status === "failed" ? "failed" : "pending" } } : {}),
    } });
  }, [state?.scope, connection, workspace, workspaceReady, configurationValid, configurationReviewed, session, selectionKey, controlLoading, controlError, dispatch]);
  return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    {notice && <p role="status">{notice}</p>}
    {!state ? <><p role="status">{loading ? "Preparing your lesson…" : "Your Cloud controls remain available while lesson progress is unavailable."}</p>
      {!loading && <Button onClick={retry}>Check lesson again</Button>}</> :
      <CloudTutorialGuide state={state} dispatch={dispatch} onShowStep={onShowStep}
        onCheckAgain={() => { onCheckAgain(); if (notice) retry(); }} />}
    {state && workspaceReady && configurationValid && configurationReviewed && !controlError && <Suspense fallback={<p role="status">Preparing your workspace session controls…</p>}><CloudTutorialSession
      key={`${selectionKey}:${state.scope.tenantId}:${state.scope.userId}:${state.scope.workspaceId}`} scope={state.scope}
      onObservation={onSessionObservation} onInspect={task => dispatch({ type: "inspect-result", scope: state.scope, sessionId: task.sessionId, taskId: task.id, resultId: task.resultId! })} /></Suspense>}
  </div>;
}
