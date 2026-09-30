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

function expectBoundedActivityRequests() {
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([input]) => String(input)).sort()).toEqual([
    `https://api.crisp.chat${conversationPath}`,
    `https://api.crisp.chat${conversationPath}/messages`,
  ]);
  for (const [, options] of fetchMock.mock.calls) {
    expect(options?.method).toBe("GET");
    expect(options?.body).toBeUndefined();
  }
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
  it("advertises required identifiers, the optional bounded note limit, and latest-batch limitations", async () => {
    const response = z.object({
      result: z.object({ tools: z.array(z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.object({
          type: z.string(),
          required: z.array(z.string()).default([]),
          properties: z.record(z.string(), z.unknown()),
        }),
      })) }),
    }).parse(await rpc("tools/list", {}));
    const tool = response.result.tools.find(({ name }) => name === "get_conversation_activity")!;
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.required.slice().sort()).toEqual(["session_id", "website_id"]);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["note_limit", "session_id", "website_id"]);
    expect(tool.inputSchema.properties).toMatchObject({
      website_id: { type: "string", minLength: 1 },
      session_id: { type: "string", minLength: 1 },
      note_limit: { type: "integer", minimum: 0, maximum: 20, default: 5 },
    });
    expect(tool.description).toContain("Reads only the latest message batch; never scans older history");
    expect(tool.description).toContain("Missing events/notes may exist in older batches");
    expect(tool.description).toContain("a note alone does not mean the conversation is handled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

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

  it.each(["file", "animation", "audio", "event"])("keeps a latest visitor %s event and its structured content", async (type) => {
    const timestamp = 1_790_000_000_123;
    const content = type === "event"
      ? { namespace: "custom:activity", text: "Visitor event", data: { value: 1 } }
      : { url: "https://example.com/attachment", name: "Attachment", nested: { value: 1 } };
    mockActivity({ state: "unresolved", updated_at: timestamp, waiting_since: 0 }, [
      { type, from: "user", timestamp, fingerprint: 0, content, user: { nickname: "Visitor" } },
      { type: "note", from: "operator", timestamp: 0, content: "**Initial**\nInternal note", user: {} },
      { type: "text", from: "operator", timestamp: timestamp - 1, content: "Reply", automated: true },
    ]);
    const result = await callActivity();
    expect(result.result.isError).toBeUndefined();
    const payload = JSON.parse(result.result.content[0].text).data;
    const visitor = {
      type, from: "user", timestamp, fingerprint: 0, content,
      user: { user_id: null, nickname: "Visitor" }, automated: false, mentions: [],
    };
    expect(payload.last_event).toEqual(visitor);
    expect(payload.last_visitor_event).toEqual(visitor);
    expect(payload.last_operator_event).toEqual({
      type: "text", from: "operator", timestamp: timestamp - 1, fingerprint: null,
      content: "Reply", user: null, automated: true, mentions: [],
    });
    expect(payload.notes).toEqual([{
      type: "note", from: "operator", timestamp: 0, fingerprint: null,
      content: "**Initial**\nInternal note", user: { user_id: null, nickname: null },
      automated: false, mentions: [],
    }]);
    expect(payload.window).toEqual({
      scope: "latest_message_batch", messages_scanned: 3,
      oldest_timestamp: 0, newest_timestamp: timestamp, notes_truncated: false,
    });
    expectBoundedActivityRequests();
  });

  it("selects maximum timestamps per sender even when multiple event types share a timestamp", async () => {
    mockActivity({ state: "resolved" }, [
      { type: "note", from: "operator", timestamp: 10, content: "Older" },
      { type: "note", from: "operator", timestamp: 20, content: "First tied note" },
      { type: "text", from: "user", timestamp: 20, content: "Tied visitor" },
      { type: "note", from: "operator", timestamp: 20, content: "Second tied note" },
    ]);
    const result = await callActivity();
    const payload = JSON.parse(result.result.content[0].text).data;
    expect(payload.last_event.timestamp).toBe(20);
    expect(["First tied note", "Tied visitor", "Second tied note"]).toContain(payload.last_event.content);
    expect(payload.last_operator_event.timestamp).toBe(20);
    expect(["First tied note", "Second tied note"]).toContain(payload.last_operator_event.content);
    expect(payload.last_visitor_event).toMatchObject({ timestamp: 20, content: "Tied visitor" });
    expect(payload.notes.map(({ timestamp }: { timestamp: number }) => timestamp)).toEqual([20, 20, 10]);
    expect(payload.notes.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "First tied note" }),
      expect.objectContaining({ content: "Second tied note" }),
    ]));
    expect(payload.window).toMatchObject({ oldest_timestamp: 10, newest_timestamp: 20 });
    expectBoundedActivityRequests();
  });

  it("preserves explicit null summary fields without treating a zero-timestamp message as an empty window", async () => {
    mockActivity({ state: "pending", updated_at: null, waiting_since: null, unread: null, assigned: null }, [
      { type: "text", from: "user", timestamp: 0, content: "", user: null, fingerprint: null, automated: null, mentions: null },
    ]);
    const result = await callActivity();
    expect(result.result.isError).toBeUndefined();
    const payload = JSON.parse(result.result.content[0].text).data;
    expect(payload).toMatchObject({
      state: "pending", updated_at: null, waiting_since: null, unread: null, assigned: null,
      last_operator_event: null, notes: [],
      last_event: { timestamp: 0, content: "", fingerprint: null, user: null, automated: false, mentions: [] },
      window: {
        scope: "latest_message_batch", messages_scanned: 1,
        oldest_timestamp: 0, newest_timestamp: 0, notes_truncated: false,
      },
    });
    expect(payload.last_visitor_event).toEqual(payload.last_event);
    expectBoundedActivityRequests();
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
    expect(payload.last_event).toEqual(payload.last_operator_event);
    expect(payload.last_visitor_event).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([-1, 21, 1.5, "3"])("rejects invalid note_limit=%s before fetching", async (noteLimit) => {
    const result = await callActivity({ ...toolArgs, note_limit: noteLimit });
    expect(result.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([null, true, [], {}])("does not coerce nonnumeric note_limit=%j", async (noteLimit) => {
    const result = await callActivity({ ...toolArgs, note_limit: noteLimit });
    expect(result.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { website_id: websiteId },
    { ...toolArgs, website_id: null },
    { ...toolArgs, website_id: 123 },
    { ...toolArgs, session_id: null },
    { ...toolArgs, session_id: [] },
  ])("rejects missing or nonstring identifiers before fetching: %j", async (args) => {
    const result = await callActivity(args);
    expect(result.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { noteLimit: undefined, noteCount: 5, truncated: false },
    { noteLimit: 20, noteCount: 20, truncated: false },
    { noteLimit: 20, noteCount: 21, truncated: true },
  ])("truncates only excess notes in the batch: %j", async ({ noteLimit, noteCount, truncated }) => {
    const notes = Array.from({ length: noteCount }, (_, timestamp) => ({
      type: "note", from: "operator", timestamp, content: `Note ${timestamp}`,
    }));
    mockActivity({ state: "pending" }, [
      { type: "text", from: "user", timestamp: noteCount + 1, content: "Newest message" },
      ...notes,
      { type: "event", from: "operator", timestamp: noteCount, content: { namespace: "state:pending" } },
    ]);
    const result = await callActivity({ ...toolArgs, ...(noteLimit === undefined ? {} : { note_limit: noteLimit }) });
    const payload = JSON.parse(result.result.content[0].text).data;
    expect(payload.notes.map(({ content }: { content: string }) => content)).toEqual(
      notes.slice().reverse().slice(0, noteLimit ?? 5).map(({ content }) => content),
    );
    expect(payload.window).toEqual({
      scope: "latest_message_batch", messages_scanned: noteCount + 2,
      oldest_timestamp: 0, newest_timestamp: noteCount + 1, notes_truncated: truncated,
    });
    expectBoundedActivityRequests();
  });

  it("scans a large batch without extra requests or claiming completeness when it contains no notes", async () => {
    mockActivity({ state: "resolved" }, Array.from({ length: 250 }, (_, timestamp) => ({
      type: "text", from: "user", timestamp, content: `Recent message ${timestamp}`,
    })));
    const result = await callActivity({ ...toolArgs, note_limit: 20 });
    const payload = JSON.parse(result.result.content[0].text).data;
    expect(payload.notes).toEqual([]);
    expect(payload.last_operator_event).toBeNull();
    expect(payload.last_event).toMatchObject({ timestamp: 249, content: "Recent message 249" });
    expect(payload.window).toEqual({
      scope: "latest_message_batch", messages_scanned: 250,
      oldest_timestamp: 0, newest_timestamp: 249, notes_truncated: false,
    });
    expectBoundedActivityRequests();
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
    expectBoundedActivityRequests();
  });

  it("surfaces network failures instead of reporting an empty history", async () => {
    fetchMock.mockRejectedValue(new Error("Network unavailable"));
    const result = await callActivity();
    expect(result.result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Network unavailable" }],
    });
    expectBoundedActivityRequests();
  });

  it.each([conversationPath, `${conversationPath}/messages`])("does not return partial activity when only %s fails on the network", async (failedPath) => {
    mockActivity({ state: "resolved" }, [{ type: "text", from: "operator", timestamp: 10, content: "Reply" }]);
    const success = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      if (new URL(String(input)).pathname === failedPath) throw new Error("Connection reset");
      return success(input, options);
    });
    const result = await callActivity();
    expect(result.result).toEqual({
      isError: true, content: [{ type: "text", text: "Connection reset" }],
    });
    expectBoundedActivityRequests();
  });

  it.each([
    { status: 429, body: { error: "rate_limited" }, reason: "rate_limited" },
    { status: 503, body: { message: "temporarily_unavailable" }, reason: "temporarily_unavailable" },
    { status: 502, body: null, reason: "Bad Gateway" },
  ])("reports upstream status $status without retrying or returning the successful conversation half", async ({ status, body, reason }) => {
    mockActivity({ state: "resolved" });
    const success = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      if (new URL(String(input)).pathname === `${conversationPath}/messages`) {
        return body === null
          ? new Response("upstream proxy failure", { status, statusText: reason })
          : Response.json(body, { status });
      }
      return success(input, options);
    });
    const result = await callActivity();
    expect(result.result).toEqual({
      isError: true,
      content: [{ type: "text", text: `Crisp API error ${status} on ${conversationPath.replace("/v1", "")}/messages: ${reason}` }],
    });
    expectBoundedActivityRequests();
  });

  it.each([conversationPath, `${conversationPath}/messages`].flatMap((failedPath) => [
    { failedPath, label: "missing data", response: () => Response.json({}) },
    { failedPath, label: "null data", response: () => Response.json({ data: null }) },
    { failedPath, label: "204 no content", response: () => new Response(null, { status: 204 }) },
    { failedPath, label: "invalid JSON", response: () => new Response("not json", { status: 200 }) },
  ]))("rejects $label at $failedPath rather than presenting an empty window", async ({ failedPath, response }) => {
    mockActivity({ state: "resolved" }, [{ type: "text", from: "user", timestamp: 10, content: "Question" }]);
    const success = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      if (new URL(String(input)).pathname === failedPath) return response();
      return success(input, options);
    });
    const result = await callActivity();
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toHaveLength(1);
    expect(result.result.content[0].text).not.toBe("");
    expect(result.result.content[0].text).not.toContain('"window"');
    expectBoundedActivityRequests();
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
