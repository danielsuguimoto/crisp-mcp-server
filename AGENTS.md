# crisp-mcp-server

MCP server for the Crisp REST API on Cloudflare Workers. Read-mostly: websites, operators, and conversations are read-only; private notes, conversation segments, conversation replies (text messages), and conversation state (resolve/unresolve) are writable.

## Commands

- `npm run dev` — local dev (wrangler dev, port 8787)
- `npm run deploy` — deploy to Cloudflare Workers
- `npm run typecheck` — typecheck source and tests with both TypeScript configurations
- `npm test` — run Vitest activity tests and Node conversation-search and website-resolution tests
- `npm run types` — regenerate `env.d.ts` via wrangler

## Architecture

- Stateless MCP server using `createMcpHandler` from `agents/mcp/server` (Streamable HTTP transport). No Durable Objects, no sessions.
- A fresh `McpServer` is built per request so the Crisp credentials from the request are scoped to that request only.
- Crisp credentials are NOT stored on the worker. The MCP client passes `Authorization: Bearer <base64(token_id:token_key)>`; the worker forwards it as `Authorization: Basic <base64(...)>` plus `X-Crisp-Tier: website|plugin` to `https://api.crisp.chat/v1`.
- Tier is selected via the `?tier=plugin` query param (default `website`).

## Crisp API endpoints used

- `GET /website/{website_id}`
- `GET /plugin/connect/websites/all/{page}` (plugin tier)
- `GET /plugin/connect/account` (plugin tier)
- `GET /website/{website_id}/operators/list`
- `GET /website/{website_id}/operators/active`
- `GET /website/{website_id}/operator/{user_id}`
- `GET /website/{website_id}/conversations/{page}`
- `GET /website/{website_id}/conversation/{session_id}`
- `GET /website/{website_id}/conversation/{session_id}/messages`
- `POST /website/{website_id}/conversation/{session_id}/message` (type=note or type=text)
- `PATCH /website/{website_id}/conversation/{session_id}/meta` (segments only)
- `GET /website/{website_id}/conversation/{session_id}/state`
- `PATCH /website/{website_id}/conversation/{session_id}/state` (pending|unresolved|resolved)

## Conventions

- Read-mostly: only private notes (POST message type=note), conversation replies (POST message type=text), conversation segments (PATCH meta segments), and conversation state (PATCH state) are writable. Do not add other write tools without explicit request.
- Tool results are returned as JSON-stringified text content. Errors return `isError: true`.
- `get_conversation_activity` combines conversation details with one latest message batch, returning focused state/notes/events without paging through history.
- Pin exact dependency versions (no floating ranges). Verify versions are >= 7 days old before bumping.
