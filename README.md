# crisp-mcp-server

An [Model Context Protocol](https://modelcontextprotocol.io) server for the [Crisp](https://crisp.chat) REST API, deployed on Cloudflare Workers.

It exposes Crisp **websites**, **operators**, and **conversations** as MCP tools so an MCP-compatible AI agent can query them, post private notes, and manage conversation segments.

## Tools

| Tool | Tier | Description |
| --- | --- | --- |
| `get_website` | both | Get a single website (workspace). |
| `list_connect_websites` | plugin | List all websites connected to the plugin token. |
| `get_connect_account` | plugin | Get the authenticated plugin account. |
| `list_website_operators` | both | List operators of a website. |
| `list_last_active_website_operators` | both | List last active operators of a website. |
| `get_website_operator` | both | Get a single operator of a website. |
| `list_conversations` | both | List conversations of a website (paginated, filterable). |
| `get_conversation` | both | Get a single conversation. |
| `get_conversation_messages` | both | Get messages of a conversation. |
| `get_conversation_activity` | both | Get current state, recent internal notes, and last operator/visitor events from one recent message batch. |
| `send_conversation_note` | both | Post a private note (operator-only, not visible to visitor). |
| `set_conversation_segments` | both | Replace the segments assigned to a conversation. |

### Focused conversation activity

Use `get_conversation_activity` for briefings that need to check whether a conversation
is waiting for an operator or was recently handled. It makes two read-only requests:
conversation details and the latest message batch. It never pages through older
history. Crisp's [messages endpoint](https://docs.crisp.chat/references/rest-api/v1/#get-messages-in-conversation)
returns the latest batch by default; this tool filters that batch locally.

| Input | Required | Description |
| --- | --- | --- |
| `website_id` | yes | Nonempty Crisp workspace ID. |
| `session_id` | yes | Nonempty conversation session ID. |
| `note_limit` | no | Maximum notes returned, integer 0–20, default 5. `0` returns an empty notes list; last-event fields can still contain a note. |

Example call:

```json
{"website_id":"your-workspace-id","session_id":"session_example","note_limit":3}
```

The JSON text result contains a `data` object with:

| Field | Returned information |
| --- | --- |
| `state` | Current Crisp state: `pending`, `unresolved`, or `resolved`. |
| `updated_at`, `waiting_since` | Conversation update and waiting timestamps in milliseconds, or `null` when absent. |
| `unread` | `{operator, visitor}` unread counts, or `null` when absent. |
| `assigned` | Assigned operator `{user_id}`, or `null` when absent. |
| `last_event` | Most recent message/note/event in the fetched batch, or `null`. |
| `last_operator_event` | Most recent entry with `from: "operator"` in the batch, including replies, notes, and events, or `null`. |
| `last_visitor_event` | Most recent entry with `from: "user"` in the batch, or `null`. |
| `notes` | Entries with `type: "note"`, newest first, capped by `note_limit`. |
| `window` | `{scope: "latest_message_batch", messages_scanned, oldest_timestamp, newest_timestamp, notes_truncated}`; timestamps are `null` for an empty batch. |

Each event/note contains `type`, `from`, `timestamp` (milliseconds), `fingerprint`
(or `null`), `content`, `user` (`{user_id, nickname}` with missing values set to
`null`, or `null` if absent), `automated` (defaults to `false`), and `mentions`
(defaults to `[]`). Text/note content is a string; other message types preserve
Crisp's content object, including event `namespace`/`text` (for example,
`state:resolved`). Full conversation metadata and unrelated messages are omitted.

Use the **current `state`** together with waiting/unread/assignment signals and
event timestamps/content. A newer visitor message after an operator reply can
indicate another action is needed; a `resolved` state can supersede that message.
An internal note, automated reply, or unread count alone does not prove the issue
was handled. This tool returns evidence rather than inferring who must act.

The window covers only the latest batch: empty `notes` or `null` event fields do
not rule out older activity. `notes_truncated` means notes in this batch were
omitted because of `note_limit`; `false` does not mean all historical notes were
retrieved. Use `get_conversation_messages` with timestamp pagination when older
context is explicitly needed. Both tiers are supported; plugin tokens need
`website:conversation:sessions` and `website:conversation:messages` scopes.
Upstream failures return the usual MCP `isError: true` result.

## Authentication

The server is **stateless and credential-free**: it does not store any Crisp token. Each MCP client passes the Crisp token directly to the endpoint.

The Crisp REST API uses Basic auth with a keypair `token_id:token_key`. Base64-encode the string `token_id:token_key` and pass it as a Bearer token to the MCP endpoint:

```
Authorization: Bearer <base64(token_id:token_key)>
```

The worker forwards that value as `Authorization: Basic <base64(...)>` to the Crisp API.

### Tier

Crisp tokens are either `website` (single workspace) or `plugin` (multi-workspace). Select the tier with the `tier` query parameter:

- `?tier=website` (default) — sets `X-Crisp-Tier: website`
- `?tier=plugin` — sets `X-Crisp-Tier: plugin`

Generate tokens from the Crisp app: **Settings → Workspace Settings → Advanced configuration → API Token** (website), or the Crisp Marketplace (plugin).

### Default website (workspace)

Website-scoped tools accept an optional `website_id`, except `get_conversation_activity`, which requires an explicit ID to keep retrieval bounded to two requests. Resolution uses the first available value:

1. Explicit `website_id` in the tool call.
2. `website_id` query parameter on the MCP URL, for example `https://<your-worker>.workers.dev/mcp?tier=website&website_id=<workspace-id>`.
3. Worker environment variable `DEFAULT_WEBSITE_ID`.
4. Automatic discovery for plugin-tier tokens, when exactly one connected website is available.

To configure a Worker-wide default, add a `vars` entry to `wrangler.jsonc`:

```jsonc
"vars": {
  "DEFAULT_WEBSITE_ID": "<workspace-id>"
}
```

For local development, put `DEFAULT_WEBSITE_ID=<workspace-id>` in `.dev.vars` (do not commit local variables).
Blank configuration values are treated as unset. An explicit blank `website_id` is rejected.

Website-tier tokens cannot list connected websites through the Crisp API, so they require an explicit ID or a configured default. Plugin auto-discovery checks the next page before choosing a sole website and returns an actionable tool error if there are no websites, multiple websites, or discovery is unavailable. Discovery is lazy and scoped to the current request's credentials; no website IDs or credentials are cached across requests. `list_connect_websites` and `get_connect_account` remain usable without a default or website discovery.

## Develop

```bash
npm install
npm run dev      # local dev at http://localhost:8787
npm run typecheck
npm test
```

## Deploy

```bash
npm run deploy
```

Then point an MCP client at `https://<your-worker>.workers.dev/mcp?tier=website` with the `Authorization: Bearer <base64(...)>` header.

### Claude Desktop / Claude Code example

```jsonc
{
  "mcpServers": {
    "crisp": {
      "url": "https://<your-worker>.workers.dev/mcp?tier=website",
      "headers": {
        "Authorization": "Bearer <base64(token_id:token_key)>"
      }
    }
  }
}
```

## How it works

- `src/index.ts` — Worker entry. Extracts the Bearer token and tier from the request, builds a fresh MCP server per request, and hands it to `createMcpHandler` (stateless Streamable HTTP transport).
- `src/crisp.ts` — Thin read-only Crisp REST client (`https://api.crisp.chat/v1`).
- `src/tools.ts` — Registers the MCP tools above.

## Notes

- Read-mostly: only private notes and conversation segments are writable; all other tools are read-only.
- Stateless: no Durable Objects, no sessions, no stored credentials.
- The Crisp token is sent by the client on every connection; rotate it from the Crisp app if leaked.
