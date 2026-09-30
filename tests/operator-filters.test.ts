import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrispClient } from "../src/crisp";
import { registerTools } from "../src/tools";

const websiteId = "8c842203-7ed8-4e29-a608-7cf78a7d2fcc";
const operatorId = "a4c32c68-be91-4e29-8a05-976e93abbe3f";
const otherOperatorId = "92a5db02-d3d6-49da-a820-9c3f447dcefe";
const payload = { data: [{ session_id: "session_example", assigned: { user_id: operatorId } }] };
const fetchMock = vi.fn<typeof fetch>();
let server: McpServer;
let client: Client;

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  server = new McpServer({ name: "filter-tests", version: "1.0.0" });
  registerTools(server, new CrispClient("test-token", "plugin"));
  client = new Client({ name: "filter-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  await server.close();
  vi.unstubAllGlobals();
});

function listConversations(args: Record<string, unknown> = {}) {
  return client.callTool({
    name: "list_conversations",
    arguments: { website_id: websiteId, ...args },
  });
}

function requestUrl() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return new URL(String(fetchMock.mock.calls[0][0]));
}

describe("list_conversations operator filters", () => {
  it("advertises the operator UUID and separate mention flag in the MCP schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "list_conversations")).toMatchObject({
      inputSchema: {
        properties: {
          assigned_operator_id: { type: "string", format: "uuid" },
          filter_assigned: { type: "string", format: "uuid" },
          filter_mention: { anyOf: [{ const: 0 }, { const: 1 }] },
        },
      },
    });
  });

  it("maps assigned_operator_id to Crisp and preserves active/waiting filters and paging", async () => {
    const result = await listConversations({
      assigned_operator_id: operatorId,
      filter_not_resolved: 1,
      order_date_waiting: 1,
      page: 2,
      per_page: 50,
    });
    const url = requestUrl();
    expect(url.pathname).toBe(`/v1/website/${websiteId}/conversations/2`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filter_assigned: operatorId,
      filter_not_resolved: "1",
      order_date_waiting: "1",
      per_page: "50",
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Basic test-token", "X-Crisp-Tier": "plugin" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(payload, null, 2) }]);
  });

  it("keeps the validated legacy filter_assigned input working", async () => {
    await listConversations({ filter_assigned: operatorId });
    expect(requestUrl().searchParams.get("filter_assigned")).toBe(operatorId);
  });

  it("accepts both assignment inputs when they agree and filter_unassigned is disabled", async () => {
    await listConversations({
      assigned_operator_id: operatorId,
      filter_assigned: operatorId,
      filter_unassigned: 0,
    });
    expect(Object.fromEntries(requestUrl().searchParams)).toEqual({
      filter_assigned: operatorId,
      filter_unassigned: "0",
    });
  });

  it("leaves listing unfiltered when no operator filter is provided", async () => {
    await listConversations();
    const url = requestUrl();
    expect(url.pathname).toBe(`/v1/website/${websiteId}/conversations/1`);
    expect(url.search).toBe("");
  });

  it("allows unassigned-only listing without an operator ID", async () => {
    await listConversations({ filter_unassigned: 1 });
    expect(Object.fromEntries(requestUrl().searchParams)).toEqual({ filter_unassigned: "1" });
  });

  it.each([0, 1] as const)("forwards filter_mention=%i without implying assignment", async (flag) => {
    await listConversations({ filter_mention: flag });
    expect(Object.fromEntries(requestUrl().searchParams)).toEqual({ filter_mention: String(flag) });
  });

  it("keeps mentions separate when an assignment filter is also supplied", async () => {
    await listConversations({ assigned_operator_id: operatorId, filter_mention: 1 });
    expect(Object.fromEntries(requestUrl().searchParams)).toEqual({
      filter_assigned: operatorId,
      filter_mention: "1",
    });
  });

  describe.each(["assigned_operator_id", "filter_assigned"])("%s validation", (field) => {
    it.each(["", " ", "Jun", "jun@example.com", "me", "all", "1", "not-a-uuid", 1, true, null])(
      "rejects unsupported value %j before fetching",
      async (value) => {
        const result = await listConversations({ [field]: value });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          expect.objectContaining({ type: "text", text: expect.stringContaining("operator user ID (UUID)") }),
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("rejects assignment combined with filter_unassigned=1 before fetching", async () => {
      const result = await listConversations({ [field]: operatorId, filter_unassigned: 1 });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("cannot be combined") }),
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("rejects conflicting assignment aliases before fetching", async () => {
    const result = await listConversations({
      assigned_operator_id: operatorId,
      filter_assigned: otherOperatorId,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("must identify the same operator") }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([operatorId, "me", "1", 2, -1, true, null])(
    "rejects unsupported mention value %j before fetching",
    async (value) => {
      const result = await listConversations({ filter_mention: value });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("filter_mention must be 0 or 1") }),
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
