import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { CrispClient, type CrispTier } from "./crisp";
import { registerTools } from "./tools";

const SERVER_NAME = "crisp-mcp-server";
const SERVER_VERSION = "0.1.0";

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

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("crisp-mcp-server", { status: 200 });
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
