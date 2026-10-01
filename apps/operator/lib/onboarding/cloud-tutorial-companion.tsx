"use client";
import { useEffect, useRef } from "react";
import { Button } from "@/app/harness/Button";
import type { TutorialStepId } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import type { WorkspaceHostConnectionRow } from "@/app/cloud-workspaces/workspace-view-model";
import { CloudTutorialGuide } from "./cloud-tutorial-guide";
import { useCloudTutorialProgress } from "./use-cloud-tutorial-progress";

export function CloudTutorialCompanion({ selectionKey, connection, controlLoading, controlError, onCheckAgain, onShowStep }: {
  selectionKey: string; connection: WorkspaceHostConnectionRow | null;
  controlLoading: boolean; controlError: Error | null;
  onCheckAgain: () => void; onShowStep: (step: TutorialStepId) => void;
}) {
  const { state, dispatch, loading, notice, retry } = useCloudTutorialProgress(selectionKey);
  const revision = useRef(0);
  useEffect(() => {
    if (!state || controlLoading) return;
    dispatch({ type: "observe", observation: { scope: state.scope, revision: ++revision.current,
      access: controlError ? "denied" : "allowed",
      ...(connection?.target === "gcp" ? { connection: { id: connection.id, provider: "gcp", validated: connection.status === "connected" } } : {}),
    } });
  }, [state?.scope, connection, controlLoading, controlError, dispatch]);
  return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    {notice && <p role="status">{notice}</p>}
    {!state ? <><p role="status">{loading ? "Preparing your lesson…" : "Your Cloud controls remain available while lesson progress is unavailable."}</p>
      {!loading && <Button onClick={retry}>Check lesson again</Button>}</> :
      <CloudTutorialGuide state={state} dispatch={dispatch} onShowStep={onShowStep}
        onCheckAgain={() => { onCheckAgain(); if (notice) retry(); }} />}
  </div>;
}
