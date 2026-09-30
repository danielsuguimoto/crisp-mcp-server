import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import readme from "../README.md?raw";
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

  it("documents optional assignment inputs, alias compatibility, and authenticated-user mentions", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((tool) => tool.name === "list_conversations");
    expect(tool?.inputSchema.required).toEqual(["website_id"]);
    expect(tool?.description).toMatch(/assigned_operator_id.*assignment.*filter_mention.*separate 0\/1.*authenticated user.*not an operator ID/);
    expect(tool?.inputSchema.properties).toMatchObject({
      assigned_operator_id: {
        description: expect.stringContaining("UUID from list_website_operators"),
      },
      filter_assigned: {
        description: expect.stringContaining("Legacy alias for assigned_operator_id"),
      },
      filter_mention: {
        description: expect.stringContaining("0: no mention filter. Does not select an assigned operator"),
        anyOf: [{ type: "number" }, { type: "number" }],
      },
      filter_unassigned: {
        description: expect.stringContaining("cannot combine with an assigned operator ID"),
      },
    });
    for (const field of ["assigned_operator_id", "filter_assigned", "filter_mention", "filter_unassigned"]) {
      expect(tool?.inputSchema.properties?.[field]).not.toHaveProperty("default");
    }
  });

  it("keeps the README operator example executable and its documented semantics explicit", async () => {
    const section = readme.split("### Filter conversations by operator\n")[1]?.split("## Authentication")[0];
    expect(section).toMatch(/UUID validation/);
    expect(section).toMatch(/rejected before contacting Crisp/);
    expect(section).toMatch(/If both inputs are supplied, they must match/);
    expect(section).toMatch(/Neither can be combined with `filter_unassigned: 1`/);
    expect(section).toMatch(/does not include conversations merely mentioning that operator/);
    expect(section).toMatch(/numeric flags `0` and `1`, not an operator ID/);
    expect(section).toMatch(/mentions of the authenticated user in\s+Crisp's authentication context/);
    expect(section).toMatch(/does not offer a mention filter targeting an arbitrary operator ID/);
    expect(section).toMatch(/plugin\s+token must not be assumed to represent a particular operator/);
    expect(section).toMatch(/does not request an “assigned OR mentioned” union/);
    const exampleBlock = section?.match(/```json\n([\s\S]*?)\n```/);
    if (!exampleBlock) throw new Error("README operator-filter JSON example is missing");
    const example: Record<string, unknown> = JSON.parse(exampleBlock[1]);
    const result = await client.callTool({ name: "list_conversations", arguments: example });
    expect(result.isError).not.toBe(true);
    const url = requestUrl();
    expect(url.pathname).toBe(`/v1/website/${example.website_id}/conversations/${example.page}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filter_assigned: example.assigned_operator_id,
      filter_not_resolved: String(example.filter_not_resolved),
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

  it.each(["assigned_operator_id", "filter_assigned"])(
    "maps uppercase UUIDs through %s with disabled unassigned and mention filters",
    async (field) => {
      const uppercaseId = operatorId.toUpperCase();
      const result = await listConversations({
        [field]: uppercaseId,
        filter_unassigned: 0,
        filter_mention: 0,
      });
      expect(result.isError).not.toBe(true);
      expect(Object.fromEntries(requestUrl().searchParams)).toEqual({
        filter_assigned: uppercaseId,
        filter_unassigned: "0",
        filter_mention: "0",
      });
    },
  );

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
    it.each([
      "", " ", "Jun", "jun@example.com", "me", "all", "1", "not-a-uuid", 1, true, null,
      ` ${operatorId}`, `${operatorId}\n`, operatorId.slice(0, -1),
      operatorId.replace(/-/g, ""), `{${operatorId}}`,
      operatorId.replace("a4c32", "g4c32"),
      operatorId.replace("4e29", "0e29"), operatorId.replace("8a05", "7a05"),
      0, false, [operatorId], { user_id: operatorId }, `${operatorId},${otherOperatorId}`,
    ])(
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

    it.each(["me", `${operatorId} `])(
      "rejects %j even when the other assignment input is valid",
      async (value) => {
        const otherField = field === "assigned_operator_id" ? "filter_assigned" : "assigned_operator_id";
        const result = await listConversations({ [field]: value, [otherField]: operatorId });
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

  it("rejects matching aliases with unassigned=1 even when the mention flag is valid", async () => {
    const result = await listConversations({
      assigned_operator_id: operatorId,
      filter_assigned: operatorId,
      filter_unassigned: 1,
      filter_mention: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("cannot be combined") }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports conflicting aliases and incompatible unassigned filtering together before fetching", async () => {
    const result = await listConversations({
      assigned_operator_id: operatorId,
      filter_assigned: otherOperatorId,
      filter_unassigned: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/must identify the same operator[\s\S]*cannot be combined/),
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([operatorId, "me", "1", 2, -1, true, null, "", "0", 0.5, false, [operatorId], { user_id: operatorId }])(
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

  it.each(["assigned_operator_id", "filter_assigned"])(
    "rejects an operator-targeted mention before fetching even with a valid %s",
    async (field) => {
      const result = await listConversations({ [field]: operatorId, filter_mention: otherOperatorId });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("filter_mention must be 0 or 1") }),
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
