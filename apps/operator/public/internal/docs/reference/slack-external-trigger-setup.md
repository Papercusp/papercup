# Slack setup — Cupboard package, bug triage, and the in-app Socket Mode route
URL: /internal/docs/reference/slack-external-trigger-setup

Install the Slack package from the Cupboard and connect it on Settings → Integrations, turn Slack bug reports into tickets with the Bug triage trigger pack, check that it works, and (for the in-app report-bug gestures only) the admin Socket Mode connect route.

## What this installs

Slack connects through the **Slack** package from the Cupboard (`libs/papercusp/plugins/slack`, published as `Papercusp/papercusp-slack`). It uses Slack Socket Mode: the host makes an outbound WebSocket connection and exposes no public webhook, acknowledges each envelope immediately, and deduplicates deliveries by Slack `event_id`. Messages arrive as provider-neutral `chat-message` records and `ext:slack:<event>` events.

Turning Slack messages into tickets is a separate package, the **Bug triage** trigger pack (`libs/papercusp/plugins/bug-triage`). It reads `chat-message` events from the channels you pick and files the ones that report a software bug as tickets in the project you pick, through an installed ticket provider (Asana or Linear).

## Connect Slack from the Cupboard

1. Open the **Cupboard**, find **Slack**, and install it. The install review lists what the package may reach (`slack.com` only) and asks for your consent.
2. Go to **Settings → Integrations** and open the **Slack** card. Choose **Create app**: Slack opens with the package's app definition filled in (Socket Mode, the `/papercusp` command, the message and mention events, and only the scopes those need). If the link cannot open, copy the definition from the card and paste it into **Create New App → From a manifest**.
3. Install the app to your Slack workspace. Under **Basic Information → App-Level Tokens**, generate an app-level token with `connections:write`; it starts with `xapp-`. Copy the bot token from **OAuth & Permissions**; it starts with `xoxb-`.
4. Paste both tokens into the card's masked fields and connect. Each value is checked against the format the package declares before it is saved. Tokens are stored host-side, are never shown again, and are never given to the package; the host attaches the bot token only to requests for `slack.com`.
5. Invite the bot to every channel it should read.

## Turn Slack bug reports into tickets

1. Install and connect a ticket provider (**Asana** or **Linear**) from the Cupboard if you have not already.
2. Install **Bug triage** from the Cupboard. Installing does not turn it on.
3. On **Settings → Integrations**, open the **Bug triage** section, choose the project, then pick the channels to watch and where to file bugs. Both are pickers filled from the connected providers; nothing is typed.
4. Review the binding, which starts disarmed, and arm it.

A bug report posted in a watched channel becomes one ticket at the chosen destination. Other messages file nothing. The destination is fixed by the installation, so a message cannot redirect a ticket.

## Check that it works

* The Slack card shows the connection as connected. A bad or revoked token shows an error on the card instead.
* Post a bug report in a watched channel: one `ext:slack:message` delivery, one run of the bug-triage binding, and one ticket at the destination. Replaying the same Slack `event_id` neither launches again nor files a second ticket.
* `ext:slack:<event>` keys are awaitable (`events:catalog`, family `external-trigger`), so an acceptance check can wait on the event instead of polling.

## The in-app Socket Mode route (report-bug gestures only)

The Slack **Report a bug** message shortcut and the reaction gestures are not part of the packages yet. They run on the app's own Slack connection, which the admin routes below create, and move into packages under `provider-adapters-to-packages-2026-10-11#P-008`. That connection does not run for a Slack source connected through the package, and it is not how you connect Slack for bug triage.

⚠ Do not connect the same Slack app both ways. Slack spreads one app's events across all of its open Socket Mode connections, so each path would see only part of the traffic.

## 0. Both routes below need a TRUSTED principal — a bare curl is refused

⚠ **Read this before running anything.** The two routes in steps 1 and 3 declare `auth: { trust: ['verified', 'trusted'] }` (`external-triggers.ts`, the `slackManifest` and `slackConnect` definitions). That is deliberate: provider-token setup must not inherit the cookie-less `unverified-loopback` fallback that sibling admin routes accept.

A plain shell `curl` resolves at rung 5 of the principal ladder (`auth/require-principal.ts`) to `trust: 'unverified-loopback'`, which is NOT in that allowlist, so it fails:

```
$ curl -fsS http://127.0.0.1:3070/api/admin/triggers/slack/manifest
HTTP 403
{"error":{"code":"forbidden","message":"trust unverified-loopback not in allowlist"}}
```

**The fix is to authenticate as the superuser bearer** (rung 3 → `trust: 'trusted'`), validated against `~/.papercusp/superuser-token` (mode 0600) and additionally required to be loopback. Every curl below carries it:

```bash
-H "Authorization: Bearer $(cat ~/.papercusp/superuser-token)"
```

No `Origin` header is needed. `requireAllowedOriginOr403` (`endpoint-route/cors.ts`) explicitly allows a request that sends no `Origin` — "non-browser: curl, server-to-server, SU bearer".

⛔ **Do not "fix" a 403 here by adding `unverified-loopback` to either route's auth tier.** That gate is the control keeping a cookie-less caller away from provider-token storage. Authenticate the caller instead.

These routes have no UI; `/admin/triggers` contains no Slack surface. The UI path is the Cupboard package described above.

## 1. Create the Slack app from the maintained manifest

Fetch the current manifest from the local operator:

```bash
curl -fsS -H "Authorization: Bearer $(cat ~/.papercusp/superuser-token)" \
  http://127.0.0.1:3070/api/admin/triggers/slack/manifest | jq .manifest
```

Paste that JSON into **Slack API → Your Apps → Create New App → From an app manifest**. The manifest enables Socket Mode, subscribes to `app_mention` and `message.im`, declares the `/papercusp` command, and requests the history scopes required for offline reconciliation.

In **Event Subscriptions**, enable Slack's **Delayed Events** option when it is available for the workspace. It extends retry coverage for a desktop that is temporarily offline; provider history remains the authoritative cold-gap source.

## 2. Generate and install the tokens

1. Under **Basic Information → App-Level Tokens**, generate an app token with `connections:write`; it starts with `xapp-`.
2. Install the app to the workspace and copy the bot token; it starts with `xoxb-`.
3. Invite the bot to every public/private channel that should participate. Record those channel IDs. DMs are learned automatically after the first live event.

## 3. Connect without putting secrets in the tree or shell history

The connect route validates the bot token with `auth.test`, writes both tokens through the existing OAuth token-storage adapter, and stores only an opaque `slack-socket:<field>` reference on `trigger_sources`. The local token file is mode 0600 and its Postgres mirror is encrypted. Responses never echo either token.

```bash
read -rsp 'Slack app token (xapp-): ' SLACK_APP_TOKEN; echo
read -rsp 'Slack bot token (xoxb-): ' SLACK_BOT_TOKEN; echo
SLACK_CHANNELS='["C0123456789"]'
jq -n \
  --arg appToken "$SLACK_APP_TOKEN" \
  --arg botToken "$SLACK_BOT_TOKEN" \
  --argjson channels "$SLACK_CHANNELS" \
  '{appToken:$appToken,botToken:$botToken,installSlug:"papercusp",channels:$channels}' \
| curl -fsS -X POST http://127.0.0.1:3070/api/admin/triggers/slack/connect \
    -H "Authorization: Bearer $(cat ~/.papercusp/superuser-token)" \
    -H 'content-type: application/json' --data-binary @-
unset SLACK_APP_TOKEN SLACK_BOT_TOKEN SLACK_CHANNELS
```

A credential problem surfaces as HTTP 400 with a detail naming the provider call, e.g. `{"ok":false,"error":"slack_connect_failed","detail":"slack_auth_test_200:invalid_auth"}`. That response means the request cleared the auth tier and the CSRF gate and reached Slack — so it is a token problem, not a setup-path problem.

## 4. Verify health

* `triggers:status` shows the Slack source as `connected`; a bad or missing credential becomes `error`, while a transient network or rate-limit failure becomes `degraded`.
* A `kind='slack'` row appears in `harness_shared.trigger_sources` for the workspace.
* `schedule:inventory` shows the managed `slack-socket-reconcile` lifecycle timer, including its last fire and last error.
* Replaying the same Socket Mode event does not launch twice because the canonical delivery ledger keys the Slack event by `event_id`.
* Once the source is live, `ext:slack:<event>` becomes awaitable (`events:catalog`, family `external-trigger`), so downstream acceptance should PARK on that key rather than poll for the row.

Slack protocol references: [https://docs.slack.dev/apis/events-api/using-socket-mode/](https://docs.slack.dev/apis/events-api/using-socket-mode/) · [https://docs.slack.dev/reference/app-manifest/](https://docs.slack.dev/reference/app-manifest/) · [https://docs.slack.dev/reference/methods/conversations.history/](https://docs.slack.dev/reference/methods/conversations.history/) · [https://docs.slack.dev/apis/web-api/rate-limits/](https://docs.slack.dev/apis/web-api/rate-limits/)
