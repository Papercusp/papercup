/** Canonical operation receipts inside the existing Workflows inspector. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  blueprintOperationHostFromInvoker, createPotAppSeam,
  type BlueprintOperationHandle, type BlueprintOperationReadOptions, type BlueprintOperationResult,
  type OperationOutputParser, type PotAppSeam,
} from '@papercusp/pot-app-seam';
import { runScheduleTool } from './ScheduleEditor';

const operationHost = blueprintOperationHostFromInvoker(async (name, args) => {
  const result = await runScheduleTool(name, args);
  if (!result.ok) throw new Error(result.message ?? 'Operation request failed');
  if (!result.data) throw new Error('Operation response is missing its receipt');
  return result.data;
});
const noBootstrap = (): never => { throw new Error('Workflows uses its existing installed harness'); };
const defaultSeam = createPotAppSeam({ ...operationHost,
  readBootstrapMarker: noBootstrap, writeBootstrapMarker: noBootstrap, ensurePot: noBootstrap,
});
type InspectorSeam = Pick<PotAppSeam, 'reviewOperation' | 'cancelOperation'> & {
  operationResult(handle: BlueprintOperationHandle, parse: OperationOutputParser<string>,
    options?: BlueprintOperationReadOptions): Promise<BlueprintOperationResult<string>>;
};

/** Generic inspector output is text; application-specific journeys add their
 * domain parse gate before storing a judged result in application state. */
function parseOutput(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined || text.length > 100_000) throw new Error('Result cannot be displayed in the inspector');
  return text;
}
const message = (error: unknown) => error instanceof Error ? error.message : 'Operation request failed';

export default function WorkflowOperationResult({ handle, seam = defaultSeam }: {
  handle: BlueprintOperationHandle;
  seam?: InspectorSeam;
}) {
  // A new receipt remounts its state: an old asynchronous read or write cannot
  // put another run's output, review reason or outcome into the selected run.
  const identity = JSON.stringify(handle);
  return <OperationReceipt key={identity} identity={identity} seam={seam} />;
}

function OperationReceipt({ identity, seam }: { identity: string; seam: InspectorSeam }) {
  const handle = JSON.parse(identity) as BlueprintOperationHandle;
  const generation = useRef(0);
  const [reviewAccess, setReviewAccess] = useState(false);
  const [result, setResult] = useState<BlueprintOperationResult<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const value = await seam.operationResult(JSON.parse(identity) as BlueprintOperationHandle,
        parseOutput, reviewAccess ? { review: true } : undefined);
      if (current === generation.current) setResult(value);
    } catch (cause) {
      if (current === generation.current) { setError(message(cause)); setResult(null); }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [identity, reviewAccess, seam]);
  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  async function act(action: () => Promise<unknown>, saved: string) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      setNotice(saved);
      await refresh();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  const review = result?.state === 'ready' ? result.businessReview : undefined;
  const status = result?.status;
  const disabled = loading || busy;
  return (
    <section className="pc-wf__insp-sec" aria-label="Operation result" aria-busy={disabled}>
      <h3 className="pc-wf__insp-h">Run result</h3>
      <p>Receipt {handle.receiptId} · Revision <code>{handle.specificationRevision}</code></p>
      <label>
        <input type="checkbox" checked={reviewAccess} disabled={busy} onChange={(event) => {
          setResult(null); setNotice(null); setReason(''); setReviewAccess(event.target.checked);
        }} /> Read as an authorized reviewer
      </label>
      <div className="pc-wf__insp-actions">
        <button type="button" className="pc-wf__btn" disabled={disabled} onClick={() => void refresh()}>Refresh result</button>
        {!reviewAccess && status && status.phase !== 'terminal' && (
          <button type="button" className="pc-wf__btn pc-wf__btn--warn" disabled={disabled || status.cancellationRequested}
            onClick={() => void act(() => seam.cancelOperation(handle, {
              requestKey: `workflow-stop:${handle.receiptId}`, reason: 'Stopped from the Workflows inspector',
            }), 'Stop request saved. The run remains active until cancellation settles.')}>
            Stop run
          </button>
        )}
      </div>
      {loading && <p role="status">Loading run result…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {result?.state === 'pending' && <p role="status">Preparation is {status?.phase}. A business outcome is still pending.</p>}
      {result && result.state !== 'ready' && result.state !== 'pending' && <p role="status">{result.state}: {result.reason}</p>}
      {result?.state === 'ready' && <>
        <p>Prepared result · Evidence <code>{result.evidenceRef}</code></p>
        {result.acceptanceEvidenceRef && <p>Evaluation evidence <code>{result.acceptanceEvidenceRef}</code></p>}
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.output}</pre>
        {review && <>
          <h4>Business outcome: {review.state}</h4>
          <p>Accountable owner: {review.accountableOwner}</p>
          {review.decision && <p>Reviewed by {review.decision.reviewerPrincipal}: {review.decision.reason}
            {' '}· Evidence <code>{review.decision.eventId}</code></p>}
          {review.state === 'pending' && <p>A distinct authorized reviewer must decide on this exact result.</p>}
          {reviewAccess && review.state === 'pending' && <>
            <label>Review reason
              <textarea value={reason} maxLength={2000} disabled={disabled}
                onChange={(event) => setReason(event.target.value)} />
            </label>
            <div className="pc-wf__insp-actions">
              {(['accept', 'reject', 'rework'] as const).map((decision) => (
                <button key={decision} type="button" className="pc-wf__btn"
                  disabled={disabled || !reason.trim()}
                  onClick={() => void act(() => seam.reviewOperation(handle, {
                    decision, reason: reason.trim(), resultFingerprint: review.resultFingerprint,
                    requestKey: `workflow-review:${handle.receiptId}:${review.resultFingerprint}:${decision}`,
                  }), 'Review request saved. The business outcome below comes from the durable result.')}>
                  {decision === 'accept' ? 'Accept result' : decision === 'reject' ? 'Reject result' : 'Request rework'}
                </button>
              ))}
            </div>
          </>}
        </>}
      </>}
    </section>
  );
}
