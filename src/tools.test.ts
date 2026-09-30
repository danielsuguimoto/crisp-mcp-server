import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CrispClient } from "./crisp";
import { registerTools } from "./tools";

const websiteId = "website/with spaces";
const sessionId = "session/with spaces";
const conversationPath = "/v1/website/website%2Fwith%20spaces/conversation/session%2Fwith%20spaces";
const toolArgs = { website_id: websiteId, session_id: sessionId };

const fetchMock = vi.fn<typeof fetch>();
let server: McpServer;
let transport: WebStandardStreamableHTTPServerTransport;
let requestId = 0;

async function rpc(method: string, params: Record<string, unknown>) {
  const response = await transport.handleRequest(new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  }));
  expect(response.status).toBe(200);
  return response.json();
}

async function callActivity(args: Record<string, unknown> = toolArgs) {
  const response = await rpc("tools/call", { name: "get_conversation_activity", arguments: args });
  return z.object({
    result: z.object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    }),
  }).parse(response);
}

function mockActivity(conversation: Record<string, unknown>, messages: Record<string, unknown>[] = []) {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.crisp.chat");
    expect(url.search).toBe("");
    if (url.pathname === conversationPath) {
      return Response.json({ data: conversation });
    }
    expect(url.pathname).toBe(`${conversationPath}/messages`);
    return Response.json({ data: messages }, { status: 206 });
  });
}

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  server = new McpServer({ name: "test-crisp", version: "0.1.0" });
  registerTools(server, new CrispClient("test-token", "website"));
  transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.1.0" },
  });
});

afterEach(async () => {
  await server.close();
  vi.unstubAllGlobals();
});

describe("get_conversation_activity", () => {
  it("returns focused state and chronologically latest events from only one message batch", async () => {
    const resolution = {
      type: "event", from: "operator", timestamp: 40, fingerprint: 4,
      content: { namespace: "state:resolved", text: "Resolved" },
      user: { user_id: "jun", nickname: "Jun", avatar: "omit-avatar" },
      automated: false,
    };
    mockActivity({
      state: "unresolved", updated_at: 60, waiting_since: 50,
      unread: { operator: 1, visitor: 0 }, assigned: { user_id: "jun" },
      meta: { email: "omit@example.com" },
    }, [
      resolution,
      { type: "note", from: "operator", timestamp: 10, content: "Old note" },
      { type: "text", from: "user", timestamp: 50, content: "One more question" },
      { type: "note", from: "operator", timestamp: 30, content: "Handled earlier", mentions: ["jun"] },
      { type: "file", from: "user", timestamp: 5, content: { url: "omit-file" } },
      { type: "note", from: "operator", timestamp: 20, content: "Investigating" },
    ]);

    const result = await callActivity({ ...toolArgs, note_limit: 2 });
    expect(result.result.isError).toBeUndefined();
    const payload = JSON.parse(result.result.content[0].text);
    expect(payload.data).toMatchObject({
      state: "unresolved", updated_at: 60, waiting_since: 50,
      unread: { operator: 1, visitor: 0 }, assigned: { user_id: "jun" },
      last_event: { type: "text", from: "user", timestamp: 50, content: "One more question" },
      last_visitor_event: { timestamp: 50 },
      last_operator_event: {
        ...resolution,
        user: { user_id: "jun", nickname: "Jun" },
        mentions: [],
      },
      notes: [
        { timestamp: 30, content: "Handled earlier", mentions: ["jun"] },
        { timestamp: 20, content: "Investigating" },
      ],
      window: {
        scope: "latest_message_batch", messages_scanned: 6,
        oldest_timestamp: 5, newest_timestamp: 50, notes_truncated: true,
      },
    });
    expect(payload.data.notes).toHaveLength(2);
    expect(result.result.content[0].text).not.toContain("omit");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({
        method: "GET",
        headers: { Authorization: "Basic test-token", "X-Crisp-Tier": "website" },
      });
    }
  });

  it.each(["pending", "unresolved", "resolved"])("keeps current %s state even when the latest event is from a visitor", async (state) => {
    mockActivity({ state }, [{ type: "text", from: "user", timestamp: 10, content: "Question" }]);
    const result = await callActivity();
    expect(JSON.parse(result.result.content[0].text).data).toMatchObject({
      state, last_event: { from: "user" }, last_operator_event: null, notes: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the latest operator reply alongside the preceding visitor event", async () => {
    mockActivity({ state: "unresolved", unread: { operator: 0, visitor: 1 } }, [
      { type: "text", from: "operator", timestamp: 20, content: "Answered", automated: true },
      { type: "text", from: "user", timestamp: 10, content: "Question" },
    ]);
    const result = await callActivity();
    expect(JSON.parse(result.result.content[0].text).data).toMatchObject({
      last_event: { from: "operator", timestamp: 20, automated: true },
      last_operator_event: { content: "Answered" },
      last_visitor_event: { content: "Question" },
    });
  });

  it("returns null events and window timestamps for an empty batch", async () => {
    mockActivity({ state: "resolved", waiting_since: 0 });
    const result = await callActivity();
    expect(JSON.parse(result.result.content[0].text)).toEqual({ data: {
      state: "resolved", updated_at: null, waiting_since: 0, unread: null, assigned: null,
      last_event: null, last_operator_event: null, last_visitor_event: null, notes: [],
      window: {
        scope: "latest_message_batch", messages_scanned: 0,
        oldest_timestamp: null, newest_timestamp: null, notes_truncated: false,
      },
    } });
  });

  it.each([[undefined, 5], [0, 0], [20, 8]])("limits notes with note_limit=%s without paging to find more", async (noteLimit, expectedCount) => {
    mockActivity({ state: "pending" }, Array.from({ length: 8 }, (_, timestamp) => ({
      type: "note", from: "operator", timestamp, content: `Note ${timestamp}`,
    })));
    const result = await callActivity({ ...toolArgs, ...(noteLimit === undefined ? {} : { note_limit: noteLimit }) });
    const payload = JSON.parse(result.result.content[0].text).data;
    expect(payload.notes).toHaveLength(expectedCount);
    expect(payload.window.notes_truncated).toBe(expectedCount < 8);
    expect(payload.last_operator_event.content).toBe("Note 7");
    expect(payload.last_visitor_event).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([-1, 21, 1.5, "3"])("rejects invalid note_limit=%s before fetching", async (noteLimit) => {
    const result = await callActivity({ ...toolArgs, note_limit: noteLimit });
    expect(result.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ session_id: sessionId }, { ...toolArgs, website_id: "" }, { ...toolArgs, session_id: "" }])("requires nonempty conversation identifiers: %j", async (args) => {
    const result = await callActivity(args);
    expect(result.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([conversationPath, `${conversationPath}/messages`])("surfaces an upstream failure at %s as an MCP tool error", async (failedPath) => {
    mockActivity({ state: "unresolved" });
    const success = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      if (new URL(String(input)).pathname === failedPath) {
        return Response.json({ reason: "not_allowed" }, { status: 403 });
      }
      return success(input, options);
    });
    const result = await callActivity();
    expect(result.result).toEqual({
      isError: true,
      content: [{ type: "text", text: `Crisp API error 403 on ${failedPath.replace("/v1", "")}: not_allowed` }],
    });
  });

  it("surfaces network failures instead of reporting an empty history", async () => {
    fetchMock.mockRejectedValue(new Error("Network unavailable"));
    const result = await callActivity();
    expect(result.result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Network unavailable" }],
    });
  });

  it("supports plugin credentials for the same bounded retrieval", async () => {
    mockActivity({ state: "resolved" });
    await new CrispClient("plugin-token", "plugin").getConversationActivity(websiteId, sessionId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).toMatchObject({
        Authorization: "Basic plugin-token", "X-Crisp-Tier": "plugin",
      });
    }
  });
});
