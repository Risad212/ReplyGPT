// Runs the API against a fake Supabase and a fake LLM. No network, no keys.
// Usage: node tests/api.test.mjs   (Node 22.18 or newer runs the .ts file directly)
import assert from "node:assert/strict";
import { onRequest, chunkText } from "../functions/api/[[route]].ts";

const env = {
  TEAM_KEY: "k", SUPABASE_URL: "http://db", SUPABASE_SERVICE_KEY: "s",
  LLM_BASE_URL: "http://llm/v1", LLM_MODEL: "m", LLM_API_KEY: "a",
};
const calls = [];
let searchResult = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, method: init.method || "GET", body: init.body });
  const j = (d, s = 200) => new Response(s === 204 ? null : JSON.stringify(d), { status: s });
  if (url.startsWith("http://llm")) return j({ choices: [{ message: { content: "No. There is no hidden charge. [Pricing]" } }] });
  if (url.includes("/rpc/search_chunks")) return j(searchResult);
  if (url.includes("/rest/v1/documents") && init.method === "POST") return j([{ id: "11111111-1111-1111-1111-111111111111" }], 201);
  if (url.includes("/rest/v1/questions") && !init.method) return j([]);
  if (url.includes("select=plugin")) return j([{ plugin: "B" }, { plugin: "A" }, { plugin: "A" }]);
  return j(null, 204);
};

const call = (method, path, body, key = "k") =>
  onRequest({ request: new Request("http://x" + path, { method, headers: { Authorization: `Bearer ${key}` }, body: body ? JSON.stringify(body) : undefined }), env });

// auth
assert.equal((await call("GET", "/api/docs", null, "bad")).status, 401);
// auth is optional: no TEAM_KEY in env -> open API
const noKey = { ...env, TEAM_KEY: "" };
assert.equal(
  (await onRequest({ request: new Request("http://x/api/plugins", { headers: {} }), env: noKey })).status,
  200
);
// unknown route
assert.equal((await call("GET", "/api/nope")).status, 404);
// plugins: sorted, unique
assert.deepEqual(await (await call("GET", "/api/plugins")).json(), { plugins: ["A", "B"] });
// chunking
assert.equal(chunkText("a\n\nb").length, 1);
assert.ok(chunkText("x".repeat(3000)).length >= 3);
// ask with a match
searchResult = [{ title: "Pricing", plugin: "A", kind: "doc", text: "No hidden charge." }];
let r = await (await call("POST", "/api/ask", { question: "Any hidden charge?", plugin: "A" })).json();
assert.equal(r.found, true);
assert.equal(r.sources[0].title, "Pricing");
assert.match(r.answer, /hidden charge/);
const llm = calls.filter((c) => c.url.startsWith("http://llm")).pop();
assert.match(JSON.parse(llm.body).messages[1].content, /Passages:/);
// ask with no match must not send passages and must say not found
searchResult = [];
r = await (await call("POST", "/api/ask", { question: "Does it support X?", plugin: "A" })).json();
assert.equal(r.found, false);
const llm2 = calls.filter((c) => c.url.startsWith("http://llm")).pop();
assert.doesNotMatch(JSON.parse(llm2.body).messages[1].content, /Passages:/);
// ask needs a question
assert.equal((await call("POST", "/api/ask", { question: "  " })).status, 400);
// add a doc and a learned answer
assert.equal((await call("POST", "/api/docs", { title: "T", plugin: "A", text: "hello world" })).status, 200);
assert.equal((await call("POST", "/api/docs", { title: "T", text: "" })).status, 400);
assert.equal((await call("POST", "/api/learn", { question: "q", answer: "a", plugin: "A" })).status, 200);
// delete validates the id
assert.equal((await call("DELETE", "/api/docs?id=not-a-uuid")).status, 400);
assert.equal((await call("DELETE", "/api/docs?id=11111111-1111-1111-1111-111111111111")).status, 200);
console.log("All API checks passed.");
