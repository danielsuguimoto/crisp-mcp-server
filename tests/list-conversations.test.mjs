import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { CrispClient } from "../src/crisp.ts";
import { registerTools } from "../src/tools.ts";

async function createServer(t) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerTools(server, new CrispClient("test-token", "website"));
  const pending = new Map();
  const transport = {
    async start() {},
    async close() {},
    async send(message) {
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    },
  };
  await server.connect(transport);
  t.after(() => server.close());
  let id = 0;
  function request(method, params = {}) {
    return new Promise((resolve) => {
      pending.set(++id, resolve);
      transport.onmessage({ jsonrpc: "2.0", id, method, params });
    });
  }
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    request,
    call: (args) => request("tools/call", { name: "list_conversations", arguments: args }),
  };
}

function mockCrisp(t) {
  const payload = { data: [{ session_id: "session_1" }] };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  return { fetchMock, payload };
}

test("publishes optional search parameters with accepted values and behavior", { timeout: 5000 }, async (t) => {
  const { request } = await createServer(t);
  const response = await request("tools/list");
  const tool = response.result.tools.find((item) => item.name === "list_conversations");
  const { properties, required } = tool.inputSchema;
  assert.equal(properties.search_query.type, "string");
  assert.deepEqual(properties.search_type.enum, ["text", "segment", "filter"]);
  assert.deepEqual(properties.search_operator.enum, ["and", "or"]);
  for (const name of ["search_query", "search_type", "search_operator"]) {
    assert.ok(!required.includes(name));
    assert.ok(properties[name].description.length > 0);
  }
  assert.match(properties.search_query.description, /filter expression/);
  assert.match(properties.search_operator.description, /filter.*defaults to and/);
});

for (const search of [
  { search_query: "SEVIS & AWA + ICES / Milos? #日本", search_type: "text" },
  { search_query: "Milos", search_type: "segment" },
  { search_query: "filter expression", search_type: "filter", search_operator: "and" },
  { search_query: "filter expression", search_type: "filter", search_operator: "or" },
  { search_query: "AWA" },
  { search_type: "text" },
  { search_operator: "or" },
]) {
  test(`forwards search parameters ${JSON.stringify(search)}`, { timeout: 5000 }, async (t) => {
    const { fetchMock, payload } = mockCrisp(t);
    const { call } = await createServer(t);
    const result = await call({
      website_id: "website/id",
      page: 3,
      per_page: 50,
      filter_unread: 0,
      include_empty: 1,
      order_date_updated: 1,
      ...search,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.result.isError, undefined);
    assert.deepEqual(JSON.parse(result.result.content[0].text), payload);
    assert.equal(fetchMock.mock.callCount(), 1);
    const [urlString, init] = fetchMock.mock.calls[0].arguments;
    const url = new URL(urlString);
    assert.equal(url.origin, "https://api.crisp.chat");
    assert.equal(url.pathname, "/v1/website/website%2Fid/conversations/3");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      per_page: "50",
      filter_unread: "0",
      include_empty: "1",
      order_date_updated: "1",
      ...search,
    });
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Basic test-token");
    assert.equal(init.headers["X-Crisp-Tier"], "website");
  });
}

test("omitting search keeps the default first page without query parameters", { timeout: 5000 }, async (t) => {
  const { fetchMock } = mockCrisp(t);
  const { call } = await createServer(t);
  const result = await call({ website_id: "website_1" });
  assert.equal(result.error, undefined);
  assert.equal(result.result.isError, undefined);
  assert.equal(fetchMock.mock.calls[0].arguments[0],
    "https://api.crisp.chat/v1/website/website_1/conversations/1");
});

test("omitting search preserves existing pagination and filters", { timeout: 5000 }, async (t) => {
  const { fetchMock } = mockCrisp(t);
  const { call } = await createServer(t);
  await call({
    website_id: "website_1", page: 4, per_page: 20, include_empty: 0,
    filter_resolved: 1, filter_assigned: "operator_1", order_date_created: 1,
  });
  const url = new URL(fetchMock.mock.calls[0].arguments[0]);
  assert.equal(url.pathname, "/v1/website/website_1/conversations/4");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    per_page: "20", include_empty: "0", filter_resolved: "1",
    filter_assigned: "operator_1", order_date_created: "1",
  });
});

test("filter searches leave the omitted operator to Crisp's default", { timeout: 5000 }, async (t) => {
  const { fetchMock } = mockCrisp(t);
  const { call } = await createServer(t);
  await call({ website_id: "website_1", search_query: "SEVIS", search_type: "filter" });
  const url = new URL(fetchMock.mock.calls[0].arguments[0]);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    search_query: "SEVIS", search_type: "filter",
  });
});

for (const invalid of [
  { search_query: 42 },
  { search_type: "keyword" },
  { search_operator: "xor" },
]) {
  test(`rejects invalid search parameters ${JSON.stringify(invalid)}`, { timeout: 5000 }, async (t) => {
    const { fetchMock } = mockCrisp(t);
    const { call } = await createServer(t);
    const result = await call({ website_id: "website_1", ...invalid });
    assert.ok(result.error || result.result?.isError);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}
