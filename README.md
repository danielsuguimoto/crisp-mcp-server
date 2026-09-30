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
| `send_conversation_note` | both | Post a private note (operator-only, not visible to visitor). |
| `set_conversation_segments` | both | Replace the segments assigned to a conversation. |

### Filter conversations by operator

Call `list_website_operators` with your `website_id` to find the operator's
`user_id`, then pass that UUID as `assigned_operator_id` to `list_conversations`.
For example, to list active conversations assigned to a specific operator:

```json
{
  "website_id": "8c842203-7ed8-4e29-a608-7cf78a7d2fcc",
  "assigned_operator_id": "a4c32c68-be91-4e29-8a05-976e93abbe3f",
  "filter_not_resolved": 1,
  "page": 1
}
```

`assigned_operator_id` maps to Crisp's `filter_assigned` query parameter. The
existing `filter_assigned` input remains supported as an alias with the same
UUID validation. Names, emails, `me`, empty strings, and malformed IDs are
rejected before contacting Crisp. If both inputs are supplied, they must match.
Neither can be combined with `filter_unassigned: 1`.

Assignment and mentions are separate:

- **Assignment** selects conversations currently assigned to the specified
  operator. It does not include conversations merely mentioning that operator.
- **Mentions** use `filter_mention: 1` for mentions of the authenticated user in
  Crisp's authentication context; `0` disables that filter. It only accepts the
  numeric flags `0` and `1`, not an operator ID. The
  [Crisp listing API](https://docs.crisp.chat/references/rest-api/v1/#list-conversations)
  does not offer a mention filter targeting an arbitrary operator ID; a plugin
  token must not be assumed to represent a particular operator.
- Supplying both filters does not request an “assigned OR mentioned” union.
  For a briefing scoped to Jun, use Jun's actual operator UUID for assignment;
  do not treat mentions as proof of assignment. To restrict those results to
  waiting conversations, add `order_date_waiting: 1` (Crisp also excludes
  non-waiting conversations when this flag is set).

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

## Develop

```bash
npm install
npm run dev      # local dev at http://localhost:8787
npm run typecheck
npm test         # filter validation and request-mapping regression tests
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
