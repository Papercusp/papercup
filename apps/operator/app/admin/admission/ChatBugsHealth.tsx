'use client';

/**
 * /admin/admission "Slack bug reports" (slack-messages-to-bug-reports-2026-10-05 P-008, D-011): per
 * Slack channel, how many reports were filed as new bugs, how many were merged into a bug that was
 * already filed, how many were suggested privately, how many were refused (with the newest reason),
 * and the newest error. One live read: the admission.chatBugs sync query.
 */

import type { CSSProperties } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import type { ChatBugsChannel, ChatBugsOverview } from '@papercusp/operator-core/lib/data-sources/chat-bugs-overview';
import { Table, type TableColumn } from '@/app/harness/Table';
import { formatTime } from '@/app/settings/integrations/ticket-integrations-client';

/** Mirrors CHAT_BUGS_QUERY in chat-bugs-overview.ts (a server module, so not imported here). */
export const CHAT_BUGS_QUERY = 'admission.chatBugs';

interface Row {
  key: string;
  workspace: string;
  channel: ChatBugsChannel;
}

const count = (n: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{n}</span>;

const COLUMNS: TableColumn<Row>[] = [
  { key: 'workspace', header: 'Slack workspace', render: (row) => row.workspace },
  {
    key: 'channel',
    header: 'Channel',
    render: (row) => (
      <span data-channel={row.channel.channelId}>
        {row.channel.channelId === 'unknown' ? 'unknown channel' : row.channel.channelId}
        {row.channel.configured ? '' : <span style={MUTED_STYLE}> (no rule)</span>}
      </span>
    ),
  },
  { key: 'filed', header: 'Filed', render: (row) => count(row.channel.filed) },
  { key: 'merged', header: 'Merged into existing', render: (row) => count(row.channel.merged) },
  { key: 'suggested', header: 'Suggested', render: (row) => count(row.channel.suggested) },
  { key: 'refused', header: 'Refused', render: (row) => count(row.channel.refused) },
  {
    key: 'lastRefusal',
    header: 'Last refusal',
    render: (row) =>
      row.channel.lastRefusal ? (
        <span style={{ overflowWrap: 'anywhere' }} title={formatTime(row.channel.lastRefusal.at)}>
          {row.channel.lastRefusal.reason}
        </span>
      ) : (
        '—'
      ),
  },
  {
    key: 'lastError',
    header: 'Last error',
    render: (row) =>
      row.channel.lastError ? (
        <span style={{ color: 'var(--bad)', overflowWrap: 'anywhere' }} title={formatTime(row.channel.lastError.at)}>
          {row.channel.lastError.message}
        </span>
      ) : (
        '—'
      ),
  },
];

export function chatBugRows(overview: ChatBugsOverview): Row[] {
  return overview.sources.flatMap((source) =>
    source.channels.map((channel) => ({
      key: `${source.dataSourceId}:${channel.channelId}`,
      workspace: source.providerAccountId ?? source.dataSourceId,
      channel,
    })),
  );
}

export default function ChatBugsHealth() {
  const live = useSyncQuery<ChatBugsOverview>({ queryName: CHAT_BUGS_QUERY, args: {} });
  const overview = live.data?.[0] ?? null;
  const rows = overview ? chatBugRows(overview) : [];
  const loadError = live.error ? (live.error instanceof Error ? live.error.message : String(live.error)) : null;

  return (
    <section aria-label="Slack bug reports" style={SECTION_STYLE}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>Slack bug reports</h2>
        <p style={MUTED_STYLE}>
          Per channel: reports filed as new bugs, reports merged into a bug that was already filed, private
          suggestions, refusals with their reason, and the last error.
        </p>
      </div>
      {loadError && !overview ? (
        <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
          Couldn’t load Slack bug reports: {loadError}
        </p>
      ) : !overview ? (
        <p role="status" style={MUTED_STYLE}>
          Loading Slack bug reports…
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table
            caption={`${rows.length} Slack channel${rows.length === 1 ? '' : 's'}`}
            columns={COLUMNS}
            rows={rows}
            getRowKey={(row) => row.key}
            emptyLabel="No Slack channel has a bug rule or a report yet."
          />
          {overview.deliveriesTruncated ? (
            <p style={MUTED_STYLE}>Only the newest failed deliveries are counted, so refusals are a minimum.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

const SECTION_STYLE: CSSProperties = { display: 'grid', gap: 12, marginTop: 24 };
const MUTED_STYLE: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, margin: '5px 0 0' };
