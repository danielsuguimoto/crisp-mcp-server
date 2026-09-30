import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { CrispClient, type CrispTier } from "./crisp";
import { registerTools } from "./tools";

const SERVER_NAME = "crisp-mcp-server";
const SERVER_VERSION = "0.1.0";

interface Env {
  DEFAULT_WEBSITE_ID?: string;
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 49 37"><path fill="#3770ec" d="M46.007 2.865l.003.023 2.074 20.888a3 3 0 0 1-2.661 3.279L32.49 28.458l-4.8 7.533a1.5 1.5 0 0 1-2.343.238l-6.132-6.331L6.04 31.329a3 3 0 0 1-3.31-2.7L.742 7.683a3 3 0 0 1 2.666-3.266L42.704.202a3 3 0 0 1 3.303 2.663"/></svg>`;

const ICON_PNG_DATAURI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAQKADAAQAAAABAAAAQAAAAABGUUKwAAAHGUlEQVRoBdVazW4cRRDunp39s4PtEDvGcOUCb4DEAyDgxgPAq6DcuUAOcODCMVyIkDhyQEgkQgKhiAPigIDEjpMQOx57/zzTfNU1U9O7PePd2R1vsq317Dc91VVfVXX3dPdav3F3pFa5hCYxRmmljKIrlzKcPVdGKw0hWxbEMMx2oacyBucQ9C17uaa0+MteM6pjVXmlIefTUh2jYdrcflXGyEBmfK5vzh03LcQcXqbpYtTwLVOeD0NJqGwKsihYrWkUZsKceHagEJMysLM6c2z50i3+FsNeBqwlJpR7xZbSWsm5vZ9Pfr5WTMBpi4EY6sSpEIorApBzHsRpdwRteMPdsS7M4WGdc+CLyVAGMI0yVwk6m+Hb546nEEAGxjq6OLEqQDKQEUbGxOdKeI4+Mp8hMHWIaT2RAVEKuUq4knBV5eXyxoSKxgD5hNUBC3Iw68LsGeusH2ezEGmWVQCbQY2t5O8XFWMMqNmWEvBq7szkMXDQIgrdtngPuBF3LHjQlauKPWVUUVVJofysGShk8Pwr7RhwHVseJVlDYhKhj6JrQ6t2owoH+x6o0qCiLGJDn5wi0cZYCrRuatVpqCtNvdHUL7f0TkfvdfVBz3x7/zyU0TbNHATTMQAkiWA8y5X1gxTachSZK+o1kqtVK1BroX6pqbdaertNLF/p6OvdYLdDGLxRfyXUEvUfD+Pb/4xMYOf1adMGE07HgLCHbcb+9ZwDaWgLhKfwEIFsIZChWg/1JgJpKV4HS1DsEkWQvtoiB+AGusfUstFSUJhkE6PPijVIPcBMsxDi2m7ovY7eahOn6x3iR59OQIFs683xQE4lWiZwtam7gTpBDia95Q7ht8NSInPXfyg1w0S9tRN8+fYaAumpFqkawAbS1VDPBk7vSbVK0CesGMnApMuuIDY9z4YGA86tvAzMXfHvJAnSOIG3GC3GkoEyF4lnoNTTnolGl+4Dxgm6aBLDpvAR4FbmGFtK3Fg/WZIddjEcMOpkkCwnCTttjT1W2lNBw0/AOLeQzrVQuNYFDsbDaKSeDsyr6yR7qQVzQ5IYmYhyYrAqJB2cdSE4Ko89jIpBoh73ReISXdjtBhRS/sAOZ4At+zifRl1uRXgUq8OzGSashV1DBtBjeadOyorIuPUzZYD0JOZgKQ7sdIKQzGWd34+6mw03A6hnYTjtY6T14HQZGbjW0e0APRbrCVumZACHuxkrsBdhH2tjluMAXvbroer3aI/LxSeT12vsib0djbgBOcE4Qnq0lAxg4YT1KWwFaQpSDmAinuTYOBkQri5vwWj8pJcMYoNFEQfgkq7tkBZXfySmkfVoMVTAEBmwCWDfhBl76JLH7xnmaS+JhqbdFTHRXCeA9u2OjmPpQkybjXoYGbCLOX7AV2YziZHPaGCOBuZat066hbp21wK8y8ZXmZN80oYaYx2PZvhgDPRHyX+9bMgXWq6pcm8tIPYzsIIYMuA6dxGFYWyW8y577QrCOpGBUmIYA6XPJh6cx+phdIkZQCTPRrRuPx1ickx/OZrg4N+mGYAXMjZLcWL2F3ZglGC/khz3DeY05PPhabIfxQcR4UdnCRbtx8OkNzK0r7ddo5RMRjjPgJuJYoyX8Qkt1S8usT0dKZT56yj+8PYxXoiIcf/coE9CGAVscQiAPQw22bjyrXAQAEkfVxgDWGMdZu8yvBAwpR71kydnNDAeRjGSQ4E8TR5E8etXw5vvbqx7O7gbP0R3/h2uNTXogiWWDF7JTmhdpp6QW4H9gHs7jvEIdrjgCEmrX/dHH31zdBglj3vUDU68QHIUf74/wjbji/c3O84Rz3d/Dr7+vY9NI+mzPGn4Ofrnw9N+5HPcw5HZoyi+dS+2LCnjsI5YIpBCwzprWqG6da/XbejP3tts2jA/G5iPvz9Bj9HQ4uhcGPOLbNw+R7zwCjLdiaM/l43TBpH+6pezbqg+eWcTrn760+lv+6M1HPqUyDtNK0FeStiFHzSzI2zCYiSZvgsxC9vpDmngQvKC0X8+v3u22Q4+eLNz807UatAqf1ye3Mnky/CYTlc/Y71140GuI+VR2xcHYHs9wAukUTBkazBkp9Ga0zpGC0HH5NvQOGsYq6/rhgYx/TyW9RvK6YzY5j6VL8d4Qh9MduUycOaizorHtm06fsZxmgHmzBKz4lTONloWprxlthiXv8jgqIiWYdJRUsqa1FXPZrNfKYtICHs8LMNF7dK6siZ11bMZ75f6Cxi9oI/yxdwLSnAaLf5vFZp4spekYPRW6ju2flFsaVhlKaFCjEoUspX1WhfzI5YRnP6vhJzBUEtuxCrqwtBri5jHXVVc2AQ7B1qOZjzZykpd+WTODcZK0bdnoyvGeIIuZqEVDj+cwZt4wqUVu83+8XXFaOd08+P1vG6lkB0DPJEufoXnPKDc908hlnmbjXLIfDwDpf8BVZxYPvdTJg4AAAAASUVORK5CYII=";

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

function createServer(token: string, tier: CrispTier, defaultWebsiteId?: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    icons: [{ src: ICON_PNG_DATAURI, mimeType: "image/png", sizes: ["64x64"] }],
  });
  const crisp = new CrispClient(token, tier, defaultWebsiteId);
  registerTools(server, crisp);
  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    const defaultWebsiteId = url.searchParams.get("website_id")?.trim() || env.DEFAULT_WEBSITE_ID?.trim();
    return createMcpHandler(() => createServer(token, tier, defaultWebsiteId))(request, env as never, ctx);
  },
} satisfies ExportedHandler<Env>;
