# crisp-mcp-server

Read-only MCP server for the Crisp REST API on Cloudflare Workers.

## Commands

- `npm run dev` — local dev (wrangler dev, port 8787)
- `npm run deploy` — deploy to Cloudflare Workers
- `npm run typecheck` — `tsc --noEmit`
- `npm run types` — regenerate `env.d.ts` via wrangler

## Architecture

- Stateless MCP server using `createMcpHandler` from `agents/mcp/server` (Streamable HTTP transport). No Durable Objects, no sessions.
- A fresh `McpServer` is built per request so the Crisp credentials from the request are scoped to that request only.
- Crisp credentials are NOT stored on the worker. The MCP client passes `Authorization: Bearer <base64(token_id:token_key)>`; the worker forwards it as `Authorization: Basic <base64(...)>` plus `X-Crisp-Tier: website|plugin` to `https://api.crisp.chat/v1`.
- Tier is selected via the `?tier=plugin` query param (default `website`).

## Crisp API endpoints used (all GET)

- `GET /website/{website_id}`
- `GET /plugin/connect/websites/all/{page}` (plugin tier)
- `GET /plugin/connect/account` (plugin tier)
- `GET /website/{website_id}/operators/list`
- `GET /website/{website_id}/operators/active`
- `GET /website/{website_id}/operator/{user_id}`
- `GET /website/{website_id}/conversations/{page}`
- `GET /website/{website_id}/conversation/{session_id}`
- `GET /website/{website_id}/conversation/{session_id}/messages`

## Conventions

- Read-only: never add POST/PATCH/PUT/DELETE tools.
- Tool results are returned as JSON-stringified text content. Errors return `isError: true`.
- Pin exact dependency versions (no floating ranges). Verify versions are >= 7 days old before bumping.
