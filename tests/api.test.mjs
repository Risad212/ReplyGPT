// Runs the API against a fake Supabase and a fake LLM. No network, no keys.
// Usage: node tests/api.test.mjs   (Node 22.18 or newer runs the .ts file directly)
import assert from "node:assert/strict";
import { onRequest, chunkText } from "../functions/api/[[route]].ts";
import worker from "../functions/api/[[route]].ts";

const env = {
  SUPABASE_URL: "http://db", SUPABASE_SERVICE_KEY: "s",
  LLM_BASE_URL: "http://llm/v1", LLM_MODEL: "m", LLM_API_KEY: "a",
  AI: { run: async (model, { text }) => ({ data: text.map((t) => [0.1 + (t.length % 7) / 10, 0.5, 0.3, 0.9]) }) },
};
const calls = [];
let searchResult = [];
let semanticResult = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, method: init.method || "GET", body: init.body });
  const j = (d, s = 200) => new Response(s === 204 ? null : JSON.stringify(d), { status: s });
  if (url.startsWith("http://llm")) {
    const body = JSON.parse(init.body || "{}");
    if (!body.stream) return j({ choices: [{ message: { content: "No. There is no hidden charge. [Pricing]" } }] });
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "No. There is " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "no hidden charge. [Pricing]" } }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.includes("/rpc/search_chunks_semantic")) return j(semanticResult);
  if (url.includes("/rpc/search_chunks")) return j(searchResult);
  if (url.includes("chunks?embedding=is.null&select=id,text")) return j([{ id: 7, text: "hello world" }]);
  if (url.includes("chunks?embedding=is.null&select=id")) return j([]);
  if (url.includes("/rest/v1/documents") && init.method === "POST") return j([{ id: "11111111-1111-1111-1111-111111111111" }], 201);
  if (url.includes("/rest/v1/questions") && !init.method) return j([]);
  if (url.includes("select=plugin")) return j([{ plugin: "B" }, { plugin: "A" }, { plugin: "A" }]);
  return j(null, 204);
};

const call = (method, path, body) =>
  onRequest({ request: new Request("http://x" + path, { method, headers: {}, body: body ? JSON.stringify(body) : undefined }), env });

// unknown route
assert.equal((await call("GET", "/api/nope")).status, 404);
// worker mode: same routing through the default export
assert.deepEqual(await (await worker.fetch(new Request("http://x/api/plugins"), env)).json(), { plugins: ["A", "B"] });
assert.equal((await worker.fetch(new Request("http://x/api/nope"), env)).status, 404);
// plugins: sorted, unique
assert.deepEqual(await (await call("GET", "/api/plugins")).json(), { plugins: ["A", "B"] });
// chunking
assert.equal(chunkText("a\n\nb").length, 1);
assert.ok(chunkText("x".repeat(3000)).length >= 3);
// ask with a match
searchResult = [{ title: "Pricing", plugin: "A", kind: "doc", text: "No hidden charge.", rank: 0.61 }];
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
// a weak match (one incidental word) must count as not found, not get cited
searchResult = [{ title: "Blog post", plugin: "A", kind: "doc", text: "payment gateway talk", rank: 0.02 }];
r = await (await call("POST", "/api/ask", { question: "SmartPay Pro features?", plugin: "A" })).json();
assert.equal(r.found, false);
assert.deepEqual(r.sources, []);
// small talk skips the search entirely and still answers
const before = calls.filter((c) => c.url.includes("/rpc/search_chunks")).length;
r = await (await call("POST", "/api/ask", { question: "Hi!", plugin: "A" })).json();
assert.equal(r.found, true);
assert.deepEqual(r.sources, []);
assert.equal(calls.filter((c) => c.url.includes("/rpc/search_chunks")).length, before);
// history is passed to the LLM
searchResult = [{ title: "Pricing", plugin: "A", kind: "doc", text: "No hidden charge.", rank: 0.61 }];
r = await (await call("POST", "/api/ask", {
  question: "And for EDD?",
  plugin: "A",
  history: [
    { role: "user", content: "Does it support subscriptions?" },
    { role: "assistant", content: "Yes, on Pro. [Pricing]" },
  ],
})).json();
assert.equal(r.found, true);
const llm3 = calls.filter((c) => c.url.startsWith("http://llm")).pop();
assert.match(JSON.parse(llm3.body).messages[1].content, /Earlier conversation:/);
assert.match(JSON.parse(llm3.body).messages[1].content, /And for EDD\?/);
// ask needs a question
assert.equal((await call("POST", "/api/ask", { question: "  " })).status, 400);
// streaming: SSE events in order, meta first, deltas join into the answer
{
  const res = await call("POST", "/api/ask/stream", { question: "Any hidden charge?", plugin: "A" });
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");
  const text = await res.text();
  const events = text.split("\n\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  assert.equal(events[0].type, "meta");
  assert.equal(events[0].found, true);
  assert.equal(events[0].sources[0].title, "Pricing");
  const deltas = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.match(deltas, /hidden charge/);
  assert.equal(events[events.length - 1].type, "done");
  const streamLlm = calls.filter((c) => c.url.startsWith("http://llm")).pop();
  assert.equal(JSON.parse(streamLlm.body).stream, true);
}
// add a doc and a learned answer
assert.equal((await call("POST", "/api/docs", { title: "T", plugin: "A", text: "hello world" })).status, 200);
assert.equal((await call("POST", "/api/docs", { title: "T", text: "" })).status, 400);
assert.equal((await call("POST", "/api/learn", { question: "q", answer: "a", plugin: "A" })).status, 200);
// delete validates the id
assert.equal((await call("DELETE", "/api/docs?id=not-a-uuid")).status, 400);
assert.equal((await call("DELETE", "/api/docs?id=11111111-1111-1111-1111-111111111111")).status, 200);
// semantic pass rescues a question the keyword search missed
searchResult = [];
semanticResult = [{ chunk_id: 99, doc_id: "22222222-2222-2222-2222-222222222222", title: "Integrations", plugin: "A", kind: "doc", text: "Works with Tutor LMS.", rank: 0.72 }];
r = await (await call("POST", "/api/ask", { question: "can I use it with my LMS?", plugin: "A" })).json();
assert.equal(r.found, true);
assert.equal(r.sources[0].title, "Integrations");
// weak semantic hits are dropped
semanticResult = [{ chunk_id: 98, doc_id: "22222222-2222-2222-2222-222222222222", title: "Blog", plugin: "A", kind: "doc", text: "unrelated", rank: 0.2 }];
r = await (await call("POST", "/api/ask", { question: "anything else?", plugin: "A" })).json();
assert.equal(r.found, false);
assert.deepEqual(r.sources, []);
semanticResult = [];
// backfill embeds chunks without embeddings and reports what is left
{
  const res = await call("POST", "/api/backfill");
  const j = await res.json();
  assert.equal(j.updated, 1);
  assert.equal(j.more, false);
  const patch = calls.filter((c) => c.method === "PATCH" && c.url.includes("chunks?id=eq.7")).pop();
  assert.ok(patch && JSON.parse(patch.body).embedding.startsWith("["));
}
console.log("All API checks passed.");
