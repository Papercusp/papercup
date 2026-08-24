'use client';

/** URL-owned app-pane host for the P-008 grouped Inbox bulk-resolve report. */
import { Suspense, useCallback } from 'react';
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import { FLAGS } from '@papercusp/flags';
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { useFlag } from '@/lib/flag-hooks';
import { encodeScopedRef } from '../chat/chat-ref-popup-params';
import {
  ReportTakeoverLayer,
  useReportTakeoverParam,
} from '../review-report/ReportTakeover';
import { WORK_ITEM_DISCUSSION_PARAM } from '../work-items/WorkItemDiscussion';
import { attentionWorkItemId } from './attention-work-item-ref';
import { useInboxAttention } from './use-inbox-pending';
import {
  INBOX_BULK_RUN_PARAM,
  useInboxBulkRun,
} from './use-inbox-bulk-run';
import './inbox-bulk-report.css';

const InboxBulkReport = lazy(() => import('./InboxBulkReport'));

export default function InboxBulkReportHost() {
  const enabled = useFlag(FLAGS.INBOX_BULK_RESOLVE);
  const report = useReportTakeoverParam(INBOX_BULK_RUN_PARAM);
  const bulk = useInboxBulkRun(report.value, {
    enabled: enabled && Boolean(report.value),
  });
  const reviewing = enabled && Boolean(report.value) && bulk.run?.phase === 'review';
  // The full attention feed is expensive. Hold no subscription until a persisted
  // review run actually owns the app pane.
  const attention = useInboxAttention(reviewing);
  const [, setInboxTarget] = useQueryStates({
    opci: parseAsString,
    opcis: parseAsString,
  });
  const [, setDiscussionRef] = useQueryState(
    WORK_ITEM_DISCUSSION_PARAM,
    parseAsString,
  );
  const openThread = useCallback(
    (item: Parameters<typeof attentionWorkItemId>[0]) => {
      const workItemId = attentionWorkItemId(item);
      void (async () => {
        await setInboxTarget({ opci: 'all', opcis: item.id });
        if (workItemId && item.harnessSlug) {
          const ref = encodeScopedRef(item.harnessSlug, workItemId);
          await setDiscussionRef(ref);
        }
        report.close();
      })();
    },
    [report, setDiscussionRef, setInboxTarget],
  );

  // `?opcbr=` is the running-strip deep link first. It takes over only once the
  // persisted run reaches review; pending/running remains visible in the strip.
  if (!reviewing || !bulk.run) return null;

  return (
    <ReportTakeoverLayer testId="inbox-bulk-report-takeover">
      <Suspense
        fallback={
          <div
            className="inbox-bulk-report__loading"
            role="status"
            aria-live="polite"
          >
            Loading Inbox report…
          </div>
        }
      >
        <InboxBulkReport
          key={bulk.run.runId}
          run={bulk.run}
          runItems={bulk.items}
          attentionItems={attention.items}
          onRefresh={attention.refresh}
          onOpenThread={openThread}
          onClose={report.close}
        />
      </Suspense>
    </ReportTakeoverLayer>
  );
}
