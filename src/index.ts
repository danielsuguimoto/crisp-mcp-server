import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { CrispClient, type CrispTier } from "./crisp";
import { registerTools } from "./tools";

const SERVER_NAME = "crisp-mcp-server";
const SERVER_VERSION = "0.1.0";

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f64d4d"/><path d="M16 7C10.5 7 6 10.6 6 15.1c0 2.6 1.5 4.9 3.8 6.4-.1 1-.6 2.4-1.3 3.4 1.6-.3 3.2-1 4.5-1.9 1 .2 2 .3 3 .3 5.5 0 10-3.6 10-8.1S21.5 7 16 7z" fill="#fff"/></svg>`;

const ROOT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>crisp-mcp-server</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:14px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a"><h1>crisp-mcp-server</h1><p>Read-mostly MCP server for the Crisp REST API. Deployed on Cloudflare Workers.</p><p>MCP endpoint: <code>/mcp?tier=website|plugin</code></p></body></html>`;

function extractToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function extractTier(request: Request, url: URL): CrispTier {
  const tier = url.searchParams.get("tier");
  return tier === "plugin" ? "plugin" : "website";
}

function createServer(token: string, tier: CrispTier): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const crisp = new CrispClient(token, tier);
  registerTools(server, crisp);
  return server;
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      return new Response(FAVICON_SVG, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
      });
    }

    if (url.pathname === "/health") {
      return new Response("crisp-mcp-server", { status: 200 });
    }

    if (url.pathname === "/") {
      return new Response(ROOT_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const token = extractToken(request);
    if (!token) {
      return new Response(
        JSON.stringify({ error: "missing_bearer_token", message: "Provide Authorization: Bearer <base64(token_id:token_key)>" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const tier = extractTier(request, url);
    return createMcpHandler(() => createServer(token, tier))(request, env as never, ctx);
  },
} satisfies ExportedHandler;
