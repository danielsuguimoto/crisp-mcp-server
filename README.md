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

### Conversation search

`list_conversations` accepts three optional [Crisp search parameters](https://docs.crisp.chat/references/rest-api/v1/#list-conversations):

- `search_query`: text for `text` or `segment` search, or a filter expression for `filter` search.
- `search_type`: `text`, `segment`, or `filter`.
- `search_operator`: `and` or `or`, used for `filter` search. Crisp defaults to `and` when omitted.

The accepted values and operator behavior follow Crisp's published REST API contract. Automated tests verify MCP validation and request forwarding using mocked Crisp responses; live Crisp search matching is not covered.

For example, `{ "website_id": "<website_id>", "search_query": "SEVIS", "search_type": "text" }` searches for conversations about SEVIS. Searches support the existing `page`, `per_page`, and filter parameters; omitting the search parameters keeps ordinary conversation listing behavior.

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

Every website-scoped tool accepts an optional `website_id`. Resolution uses the first available value:

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
