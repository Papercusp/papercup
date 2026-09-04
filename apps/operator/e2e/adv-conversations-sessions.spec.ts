/**
 * /adv Conversations live-chat + Create/Sessions roster end-to-end coverage.
 *
 * WI-3238 follow-up: the work-item detail/chat-launch flow already has a
 * browser spec. The remaining uncovered surfaces were:
 *
 *   1. /adv?tab=conversations&conv=agentchats live chats embed the real
 *      interactive ChatPanel instead of falling back to a read-only transcript.
 *   2. /adv?tab=plans&view=sessions renders the mounted SessionsRosterView
 *      through the current Create dock route (not the legacy /adv/sessions
 *      client).
 *
 * The test is hermetic: sync reads are fulfilled through `_sync-stub.ts` (the
 * live per-query `GET /api/zero-harness/rest-query`), Conversations' comms reads
 * are fulfilled by /api/admin/comms stubs, and ChatPanel's per-harness fallback
 * REST route is stubbed so no live substrate or model call is needed.
 *
 * This spec used to stub `POST /api/zero-harness/rest-query-batch`, dead since
 * 2026-07-26 — the stub was never hit and both views rendered from real,
 * unstubbed traffic (WI-39533).
 */
import { test, expect, type Page, type Route } from './_egress';
import { stubSyncQueries, type SyncQueryStub } from './_sync-stub';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;
const SLUG = process.env.ADV_CONV_SESSIONS_E2E_SLUG ?? 'e2e-adv-conv-sessions-pot';
const WORKSPACE_ID = 'e2e-workspace';
const CHAT_ID = 'chat-live-1';
const CHAT_HARNESS = 'papercup';
const AGENT_ID = 'su-e2e-live-worker';

const nowIso = '2026-07-06T20:00:00.000Z';
const nowMs = Date.parse(nowIso);

const rosterResponse = {
  active: [
    {
      ownerId: AGENT_ID,
      label: 'su · e2e worker',
      source: 'codex-cli',
      intent: 'Cover the sessions roster with a real browser test',
      currentFiles: ['apps/operator/e2e/adv-conversations-sessions.spec.ts'],
      host: 'e2e-host',
      pid: 4242,
      startedAt: nowIso,
      heartbeatAt: nowIso,
      liveness: 'live',
      stale: false,
      workspaceId: WORKSPACE_ID,
      userId: null,
      revoked: false,
      pidAlive: true,
      modes: ['auto'],
      hasLaunchRecord: true,
      advSessionId: 77,
      currentPlanSlug: 'production-test-readiness-2026-07-06',
      role: 'worker',
      feature: 'WI-3238',
      agent: 'codex',
      mode: 'console',
      windowId: 'win-e2e',
      ompThreadId: null,
      sessionId: 'session-e2e',
      nativeSession: null,
      cwd: '/repo',
      launchStartedAt: nowIso,
    },
  ],
  ended: [
    {
      id: 1001,
      label: 'ended e2e agent',
      role: 'validator',
      feature: null,
      agent: 'claude',
      planSlug: null,
      endedAt: nowIso,
    },
  ],
};

const chatDetail = {
  id: CHAT_ID,
  harness_slug: CHAT_HARNESS,
  role: 'worker',
  feature_id: 'F-123',
  title: 'live browser chat',
  created_at: nowMs,
  archived_at: null,
  total_input_tokens: 2,
  total_output_tokens: 3,
  total_cost_usd_cents: 4,
  transcript: [
    {
      ts: nowIso,
      role: 'user',
      content: 'read-only comms transcript text',
    },
  ],
};

/** `conversations.agentChatList` — the rail row (AgentChatRow, snake_case). */
const chatListRow = {
  id: CHAT_ID,
  harness_slug: CHAT_HARNESS,
  role: 'worker',
  feature_id: 'F-123',
  title: 'live browser chat',
  created_at: nowMs,
  updated_at: nowMs,
  archived_at: null,
  total_input_tokens: 2,
  total_output_tokens: 3,
  total_cost_usd_cents: 4,
  turns: 1,
};

/** `agentChats.detail` — the EMBEDDED ChatPanel's own row (camelCase). */
const chatPanelRow = {
  harnessSlug: CHAT_HARNESS,
  id: CHAT_ID,
  role: 'worker',
  featureId: 'F-123',
  title: 'live browser chat',
  transcript: [
    {
      ts: nowIso,
      role: 'user',
      content: 'sync-backed live panel turn',
    },
  ],
  totalInputTokens: 2,
  totalOutputTokens: 3,
  totalCostUsdCents: 4,
  createdAt: nowMs,
  updatedAt: nowMs,
  archivedAt: null,
};

async function stubCommonApis(page: Page): Promise<SyncQueryStub> {
  await page.route('**/api/harness/projects/lite', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        projects: [
          {
            slug: SLUG,
            path: `/tmp/${SLUG}`,
            name: SLUG,
            hasState: true,
            hasSpec: true,
            parent_slug: null,
            harness_kind: 'project',
            is_shared: false,
          },
        ],
      }),
    });
  });

  await page.route('**/api/admin/comms/agent-chats/list', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: CHAT_ID,
            harness_slug: CHAT_HARNESS,
            role: 'worker',
            feature_id: 'F-123',
            title: 'live browser chat',
            created_at: nowMs,
            archived_at: null,
            turns: 1,
          },
        ],
        total: 1,
      }),
    });
  });
  await page.route('**/api/admin/comms/agent-chats/get', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ chat: chatDetail }),
    });
  });

  await page.route('**/api/harness/*/agent-chats/**', async (route: Route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: CHAT_ID,
        role: 'worker',
        feature_id: 'F-123',
        title: 'live browser chat',
        transcript: chatPanelRow.transcript,
        total_input_tokens: 2,
        total_output_tokens: 3,
        total_cost_usd_cents: 4,
        created_at: nowIso,
        updated_at: nowIso,
        archived_at: null,
      }),
    });
  });

  // Sync — the LIVE contract, one `GET /api/zero-harness/rest-query?name=&args=`
  // per query (see `_sync-stub.ts`). The empty `plans.*` answers below are
  // DELIBERATE models (these views must render with no plans); every query this
  // spec does not model returns `undefined` and FALLS THROUGH untouched, because
  // blanket-answering `[]` starves the dock layout.
  return stubSyncQueries(page, (name, args) => {
    switch (name) {
      case 'harnessProjects.lite':
        return [
          {
            slug: SLUG,
            path: `/tmp/${SLUG}`,
            name: SLUG,
            parent_slug: null,
            harness_kind: 'project',
            is_shared: false,
          },
        ];
      case 'plans.list':
      case 'plans.items':
      case 'plans.attention':
        return [];
      case 'plans.viewer':
        return [{ email: null }];
      case 'advRoster.list':
        return [rosterResponse];
      // The Conversations rail + detail header read the unified conversations
      // queries (AdvConversationsTab.tsx:2048), NOT `agentChats.byHarness` —
      // that name belongs to the retired PiTerminalsDock and nothing on this
      // route ever asks for it (measured: 20 rest-query names observed, none of
      // them that one).
      case 'conversations.agentChatList':
        return [chatListRow];
      case 'conversations.agentChatDetail':
        return [chatDetail];
      // The EMBEDDED live ChatPanel has its own query (ChatPanel.tsx:106),
      // keyed by chat id — this is the row that must carry the sync-backed
      // transcript the test distinguishes from the read-only fallback.
      case 'agentChats.detail':
        return args?.id === CHAT_ID ? [chatPanelRow] : [];
      case 'agentDetail.byOwner':
        return [
          {
            ownerId: AGENT_ID,
            locks: { held: [], waiting: [], error: null },
            coord: {
              lastMessage: null,
              unreadCount: 0,
              unread: [],
              openHandoffs: [],
              openEscalations: [],
              error: null,
            },
            nativeSession: null,
            codex: null,
          },
        ];
      default:
        return undefined;
    }
  });
}

test.describe('/adv Conversations + Sessions e2e', () => {
  test('Conversations agent-chat detail embeds the interactive ChatPanel for a live chat', async ({
    page,
  }) => {
    const sync = await stubCommonApis(page);
    await page.goto(`${baseURL}/adv?tab=conversations&conv=agentchats&chat=${CHAT_ID}`, {
      waitUntil: 'domcontentloaded',
    });

    // Prove the stub is feeding the view before the 20s content wait — a
    // bypassed stub then fails in seconds with a diagnostic.
    await sync.waitForServed(['agentChats.detail']);

    const liveChat = page.getByTestId('advconv-live-chat');
    await expect(liveChat).toBeVisible({ timeout: 20_000 });
    await expect(liveChat.locator('.chat-panel')).toBeVisible();
    await expect(liveChat.getByText('sync-backed live panel turn')).toBeVisible();
    await expect(liveChat.getByPlaceholder(/Message worker about F-123/)).toBeVisible();

    // The comms detail transcript is present only in the read-only fallback.
    // The live path should replace it with ChatPanel's sync-backed transcript.
    await expect(page.getByText('read-only comms transcript text')).toHaveCount(0);

    // Falsifier for this spec's own hermeticity.
    sync.assertServed('agentChats.detail');
  });

  test('Create Sessions view renders the current SessionsRosterView route and opens an agent dossier', async ({
    page,
  }) => {
    // The sessions dock is a DENSE multi-panel view: at the default 1280×720
    // Desktop-Chrome viewport the left chat rail + steering sidebar leave the
    // dockview ~540px, its panels pinch to near-zero width and their sashes /
    // the neighbouring plan quick-filter column paint OVER the roster rows, so
    // a row click is intercepted before it lands. Give the dock real estate —
    // the subject here is the roster→dossier interaction, not the pinch layout.
    await page.setViewportSize({ width: 1600, height: 1000 });

    const sync = await stubCommonApis(page);
    await page.goto(`${baseURL}/adv?tab=plans&view=sessions&slug=${SLUG}&scope=self`, {
      waitUntil: 'domcontentloaded',
    });

    await sync.waitForServed(['advRoster.list'], 30_000);

    const roster = page.locator('.pc-roster').first();
    await expect(roster.getByText('Active agents')).toBeVisible({ timeout: 30_000 });
    await expect(roster.getByText('production-test-readiness')).toBeVisible();
    const row = roster.getByRole('button', { name: /su · e2e worker/ });
    await expect(row).toBeVisible();
    await expect(row.locator('.pc-roster__chip', { hasText: 'worker' })).toBeVisible();
    await expect(row.locator('.pc-roster__file-chip', { hasText: 'adv-conversations-sessions.spec.ts' })).toBeVisible();

    await row.click();
    const detail = page.getByRole('complementary', { name: 'Agent detail' });
    // WI-7310: the pane title, not the machine-text `__id` role. `.pc-dossier__id`
    // matches every inline id/event-key in the body too, so this locator was one
    // subscriptions-bearing fixture away from a strict-mode multi-match.
    await expect(detail.locator('.pc-dossier__title')).toHaveAttribute('title', AGENT_ID);
    await expect(detail.getByText('su · e2e worker')).toBeVisible();
    await expect(detail.getByText('Cover the sessions roster with a real browser test')).toBeVisible();
    await expect(detail.getByText('WI-3238')).toBeVisible();

    sync.assertServed('advRoster.list', 'agentDetail.byOwner');
  });
});
