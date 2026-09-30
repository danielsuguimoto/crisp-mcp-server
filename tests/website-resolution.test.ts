import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { CrispClient } from "../src/crisp";
import worker from "../src/index";

const toolResponse = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  }),
});

async function rpc(
  method: string,
  params: Record<string, unknown>,
  query = "",
  env: { DEFAULT_WEBSITE_ID?: string } = {},
  token = "test-token",
): Promise<unknown> {
  const response = await worker.fetch(
    new Request(`https://example.com/mcp${query}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
      exports: {},
      abort() {},
    } as ExecutionContext,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data, body);
  return JSON.parse(data.slice(6));
}

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  query = "",
  env: { DEFAULT_WEBSITE_ID?: string } = {},
  token = "test-token",
) {
  return toolResponse.parse(
    await rpc("tools/call", { name, arguments: args }, query, env, token),
  ).result;
}

function mockCrisp(
  t: TestContext,
  respond: (url: URL, init: RequestInit) => Response | Promise<Response> = () =>
    Response.json({ data: { ok: true } }),
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.crisp.chat");
      calls.push({ url, init });
      return respond(url, init);
    },
  );
  return calls;
}

const websiteTools = [
  { name: "get_website", args: {}, path: "", method: "GET" },
  {
    name: "list_website_operators",
    args: {},
    path: "/operators/list",
    method: "GET",
  },
  {
    name: "list_last_active_website_operators",
    args: {},
    path: "/operators/active",
    method: "GET",
  },
  {
    name: "get_website_operator",
    args: { user_id: "operator" },
    path: "/operator/operator",
    method: "GET",
  },
  {
    name: "list_conversations",
    args: { page: 2, filter_unread: 1 },
    path: "/conversations/2",
    method: "GET",
    query: "?filter_unread=1",
  },
  {
    name: "get_conversation",
    args: { session_id: "session" },
    path: "/conversation/session",
    method: "GET",
  },
  {
    name: "get_conversation_messages",
    args: { session_id: "session", timestamp_before: 123 },
    path: "/conversation/session/messages",
    method: "GET",
    query: "?timestamp_before=123",
  },
  {
    name: "send_conversation_note",
    args: { session_id: "session", content: "note", mentions: ["operator"] },
    path: "/conversation/session/message",
    method: "POST",
    body: {
      type: "note",
      from: "operator",
      origin: "chat",
      content: "note",
      mentions: ["operator"],
    },
  },
  {
    name: "send_conversation_message",
    args: {
      session_id: "session",
      content: "reply",
      fingerprint: 123,
      mentions: ["operator"],
    },
    path: "/conversation/session/message",
    method: "POST",
    body: {
      type: "text",
      from: "operator",
      origin: "chat",
      content: "reply",
      fingerprint: 123,
      mentions: ["operator"],
    },
  },
  {
    name: "get_conversation_state",
    args: { session_id: "session" },
    path: "/conversation/session/state",
    method: "GET",
  },
  {
    name: "set_conversation_state",
    args: { session_id: "session", state: "resolved" },
    path: "/conversation/session/state",
    method: "PATCH",
    body: { state: "resolved" },
  },
  {
    name: "set_conversation_segments",
    args: { session_id: "session", segments: ["vip"] },
    path: "/conversation/session/meta",
    method: "PATCH",
    body: { segments: ["vip"] },
  },
] satisfies {
  name: string;
  args: Record<string, unknown>;
  path: string;
  method: string;
  query?: string;
  body?: unknown;
}[];

test("tools advertise optional website_id and retain other required fields", async (t) => {
  const calls = mockCrisp(t);
  const response = z
    .object({
      result: z.object({
        tools: z.array(
          z.object({
            name: z.string(),
            inputSchema: z.object({ required: z.array(z.string()).optional() }),
          }),
        ),
      }),
    })
    .parse(await rpc("tools/list", {}));
  for (const { name, args } of websiteTools) {
    const tool = response.result.tools.find((tool) => tool.name === name);
    assert.ok(tool);
    assert.ok(!tool.inputSchema.required?.includes("website_id"));
    if ("session_id" in args)
      assert.ok(tool.inputSchema.required?.includes("session_id"));
  }
  assert.equal(calls.length, 0);
});

for (const tool of websiteTools) {
  test(`${tool.name} uses the env default and honors explicit overrides`, async (t) => {
    const calls = mockCrisp(t);
    for (const explicit of [undefined, "override/site"]) {
      const result = await callTool(
        tool.name,
        { ...tool.args, website_id: explicit },
        "",
        { DEFAULT_WEBSITE_ID: "env-default" },
      );
      assert.equal(result.isError, undefined);
      const call = calls.at(-1);
      assert.ok(call);
      assert.equal(
        call.url.pathname,
        `/v1/website/${encodeURIComponent(explicit ?? "env-default")}${tool.path}`,
      );
      assert.equal(call.url.search, tool.query ?? "");
      assert.equal(call.init.method, tool.method);
      if (tool.body)
        assert.deepEqual(JSON.parse(String(call.init.body)), tool.body);
    }
    assert.equal(calls.length, 2);
  });
}

test("env defaults apply in both tiers without discovery", async (t) => {
  const calls = mockCrisp(t);
  for (const tier of ["website", "plugin"]) {
    const result = await callTool("get_website", {}, `?tier=${tier}`, {
      DEFAULT_WEBSITE_ID: " env-default ",
    });
    assert.equal(result.isError, undefined);
  }
  assert.deepEqual(
    calls.map(({ url }) => url.pathname),
    ["/v1/website/env-default", "/v1/website/env-default"],
  );
});

test("blank query defaults fall back to env defaults", async (t) => {
  const calls = mockCrisp(t);
  await callTool("get_website", {}, "?website_id=%20", {
    DEFAULT_WEBSITE_ID: "env-default",
  });
  assert.equal(calls[0].url.pathname, "/v1/website/env-default");
});

test("URL defaults override env defaults and explicit IDs override both", async (t) => {
  const calls = mockCrisp(t);
  await callTool("get_website", {}, "?website_id=query-default", {
    DEFAULT_WEBSITE_ID: "env-default",
  });
  await callTool(
    "get_website",
    { website_id: "explicit" },
    "?website_id=query-default",
    { DEFAULT_WEBSITE_ID: "env-default" },
  );
  await callTool("get_website", {}, "?website_id=query-only");
  assert.deepEqual(
    calls.map(({ url }) => url.pathname),
    [
      "/v1/website/query-default",
      "/v1/website/explicit",
      "/v1/website/query-only",
    ],
  );
});

test("plugin tier discovers the only workspace and forwards request credentials", async (t) => {
  const calls = mockCrisp(t, (url) =>
    Response.json({
      data: url.pathname.endsWith("/all/1")
        ? [{ website_id: "only-site" }]
        : [],
    }),
  );
  const result = await callTool("list_conversations", {}, "?tier=plugin", {
    DEFAULT_WEBSITE_ID: " ",
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    calls.map(({ url }) => url.pathname),
    [
      "/v1/plugin/connect/websites/all/1",
      "/v1/plugin/connect/websites/all/2",
      "/v1/website/only-site/conversations/1",
    ],
  );
  for (const { url, init } of calls) {
    assert.equal(url.search, "");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), "Basic test-token");
    assert.equal(headers.get("X-Crisp-Tier"), "plugin");
  }
});

const failures = [
  {
    name: "no workspaces",
    pages: [{ data: [] }],
    reason: /No connected Crisp websites/,
  },
  {
    name: "multiple workspaces",
    pages: [{ data: [{ website_id: "one" }, { website_id: "two" }] }],
    reason: /Multiple connected Crisp websites/,
  },
  {
    name: "another workspace on page 2",
    pages: [
      { data: [{ website_id: "one" }] },
      { data: [{ website_id: "two" }] },
    ],
    reason: /Multiple connected Crisp websites/,
  },
  {
    name: "invalid response",
    pages: [{ data: {} }],
    reason: /invalid connected websites response/,
  },
  {
    name: "missing website ID",
    pages: [{ data: [{}] }],
    reason: /invalid connected websites response/,
  },
  {
    name: "blank website ID",
    pages: [{ data: [{ website_id: " " }] }],
    reason: /invalid connected websites response/,
  },
  {
    name: "invalid page 2",
    pages: [{ data: [{ website_id: "one" }] }, {}],
    reason: /invalid connected websites response/,
  },
];

for (const scenario of failures) {
  test(`auto-resolution fails actionably for ${scenario.name} before any write`, async (t) => {
    const calls = mockCrisp(t, (url) => {
      const page = Number(url.pathname.split("/").at(-1));
      return Response.json(scenario.pages[page - 1]);
    });
    const result = await callTool(
      "set_conversation_state",
      { session_id: "session", state: "resolved" },
      "?tier=plugin",
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, scenario.reason);
    assert.match(
      result.content[0].text,
      /Pass website_id explicitly, set DEFAULT_WEBSITE_ID, or add \?website_id=/,
    );
    assert.equal(calls.length, scenario.pages.length);
    assert.ok(calls.every(({ init }) => init.method === "GET"));
  });
}

test("unavailable discovery includes the API error and configuration advice", async (t) => {
  const calls = mockCrisp(t, () =>
    Response.json({ reason: "unauthorized" }, { status: 401 }),
  );
  const result = await callTool("get_website", {}, "?tier=plugin");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Crisp API 401.*unauthorized/);
  assert.match(result.content[0].text, /DEFAULT_WEBSITE_ID/);
  assert.equal(calls.length, 1);
});

test("network failures are returned as actionable MCP errors", async (t) => {
  mockCrisp(t, () => {
    throw new Error("network unavailable");
  });
  const result = await callTool("get_website", {}, "?tier=plugin");
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /network unavailable.*DEFAULT_WEBSITE_ID/,
  );
});

test("website tier requires configuration and does not call a plugin-only endpoint", async (t) => {
  const calls = mockCrisp(t);
  const result = await callTool("get_website");
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /Website-tier tokens cannot list.*DEFAULT_WEBSITE_ID/,
  );
  assert.equal(calls.length, 0);
});

test("discovery is shared by concurrent resolutions within a client, with explicit overrides preserved", async (t) => {
  const calls = mockCrisp(t, (url) =>
    Response.json({
      data: url.pathname.endsWith("/all/1")
        ? [{ website_id: "only-site" }]
        : [],
    }),
  );
  const crisp = new CrispClient("token", "plugin");
  assert.deepEqual(
    await Promise.all([crisp.resolveWebsiteId(), crisp.resolveWebsiteId()]),
    ["only-site", "only-site"],
  );
  assert.equal(await crisp.resolveWebsiteId(), "only-site");
  assert.equal(await crisp.resolveWebsiteId("override"), "override");
  assert.equal(calls.length, 2);
});

test("auto-resolved websites are isolated between authenticated requests", async (t) => {
  const calls = mockCrisp(t, (url, init) => {
    const token = new Headers(init.headers).get("Authorization");
    return Response.json({
      data: url.pathname.endsWith("/all/1")
        ? [
            {
              website_id: token === "Basic token-one" ? "site-one" : "site-two",
            },
          ]
        : [],
    });
  });
  await callTool("get_website", {}, "?tier=plugin", {}, "token-one");
  await callTool("get_website", {}, "?tier=plugin", {}, "token-two");
  assert.deepEqual(
    calls.map(({ url }) => url.pathname),
    [
      "/v1/plugin/connect/websites/all/1",
      "/v1/plugin/connect/websites/all/2",
      "/v1/website/site-one",
      "/v1/plugin/connect/websites/all/1",
      "/v1/plugin/connect/websites/all/2",
      "/v1/website/site-two",
    ],
  );
});

test("plugin account and website listing tools do not require website resolution", async (t) => {
  const calls = mockCrisp(t);
  await callTool("get_connect_account", {}, "?tier=plugin");
  await callTool("list_connect_websites", { page: 3 }, "?tier=plugin");
  assert.deepEqual(
    calls.map(({ url }) => url.pathname),
    ["/v1/plugin/connect/account", "/v1/plugin/connect/websites/all/3"],
  );
});

test("an empty explicit website_id is rejected before any upstream request", async (t) => {
  const calls = mockCrisp(t);
  const result = await callTool("get_website", { website_id: " " }, "", {
    DEFAULT_WEBSITE_ID: "env-default",
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});
