// Ask Desk API. One Cloudflare Pages Function that handles every /api/* request.
// Talks to Supabase through its REST interface and to any OpenAI-compatible LLM endpoint.

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  LLM_API_KEY: string;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

type Row = Record<string, any>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_RANK = 0.07;
const enc = encodeURIComponent;

// ---------- helpers ----------

async function sb(env: Env, path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new HttpError(502, `Database error (${res.status}).`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function normalize(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

export function chunkText(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const merged: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > 900) {
      merged.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) merged.push(cur);
  const out: string[] = [];
  for (const c of merged) for (let i = 0; i < c.length; i += 1200) out.push(c.slice(i, i + 1200));
  return out;
}

async function readJson(request: Request): Promise<Row> {
  try {
    const body = await request.json();
    if (body && typeof body === "object") return body as Row;
  } catch {}
  throw new HttpError(400, "Send a JSON body.");
}

async function createDoc(env: Env, d: { title: string; plugin: string; kind: string; source_url?: string; text: string }): Promise<string> {
  const chunks = chunkText(d.text);
  if (!chunks.length) throw new HttpError(400, "The text is empty.");
  const created = await sb(env, "documents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ title: d.title, plugin: d.plugin, kind: d.kind, source_url: d.source_url || null }),
  });
  const id: string = created[0].id;
  const rows = chunks.map((text) => ({ doc_id: id, plugin: d.plugin, kind: d.kind, text }));
  try {
    for (let i = 0; i < rows.length; i += 200) {
      await sb(env, "chunks", { method: "POST", body: JSON.stringify(rows.slice(i, i + 200)) });
    }
  } catch (e) {
    await sb(env, `documents?id=eq.${id}`, { method: "DELETE" }).catch(() => {});
    throw e;
  }
  return id;
}

async function deleteWhere(env: Env, filter: string): Promise<void> {
  await sb(env, `documents?${filter}`, { method: "DELETE" });
}

async function logQuestion(env: Env, question: string, plugin: string, found: boolean): Promise<void> {
  try {
    const key = `${plugin}|${normalize(question)}`.slice(0, 300);
    const existing = await sb(env, `questions?key=eq.${enc(key)}&select=count`);
    const now = new Date().toISOString();
    if (existing && existing.length) {
      await sb(env, `questions?key=eq.${enc(key)}`, {
        method: "PATCH",
        body: JSON.stringify({ count: existing[0].count + 1, found, last_asked: now }),
      });
    } else {
      await sb(env, "questions", {
        method: "POST",
        body: JSON.stringify({ key, text: question.slice(0, 500), plugin, count: 1, found, last_asked: now }),
      });
    }
  } catch {
    // Counting is a convenience. Never fail an answer because of it.
  }
}

async function callLlm(env: Env, system: string, user: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new HttpError(502, `The AI service returned an error (${res.status}). Check LLM_BASE_URL, LLM_MODEL and LLM_API_KEY.`);
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new HttpError(502, "The AI service sent an empty answer.");
    return String(text).trim();
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    if (e?.name === "AbortError") throw new HttpError(504, "The AI service took too long. Try again.");
    throw new HttpError(502, "Could not reach the AI service.");
  } finally {
    clearTimeout(timer);
  }
}

// ---------- prompts ----------

function systemPrompt(found: boolean, asReply: boolean): string {
  const style = asReply
    ? "Write the answer as a short, friendly message the support agent can send to the customer as it is. No greeting line with a name, no signature."
    : "Write a short, plain answer for the support agent.";
  if (found) {
    return [
      "You help a support team answer customer questions about their software plugins.",
      "Use ONLY the numbered passages you are given. Do not add features, versions, prices, integrations or policies that the passages do not state.",
      "Passages from documents titled 'Learned:' are answers the team confirmed. If passages conflict, trust the 'Learned:' ones.",
      "If the passages only partly answer the question, give the part they support and say what is missing.",
      "If the passages do not answer the question at all, say in one short sentence that the documents do not cover it, suggest checking the plugin documentation or asking a teammate, and cite no documents.",
      "When you do use passages, end with the document title you used in brackets, like [Refund policy]. Never write a placeholder instead of a real title.",
      "Answer in the same language as the question (English or Bangla).",
      style,
    ].join("\n");
  }
  return [
    "You help a support team answer customer questions about their software plugins.",
    "The team's documents did not contain anything relevant to this question.",
    "Say that in one short sentence, and suggest the agent check the plugin documentation or ask a teammate.",
    "Never guess about the company's own plugins: no features, integrations, prices, versions or policies.",
    "Only if the question is general knowledge that has nothing to do with the company's products, add a short answer labelled 'General knowledge (not from your documents):'.",
    "Answer in the same language as the question (English or Bangla).",
  ].join("\n");
}

// ---------- routes ----------

async function plugins(env: Env) {
  const rows: Row[] = await sb(env, "documents?select=plugin&plugin=neq.&limit=5000");
  const names = [...new Set(rows.map((r) => r.plugin as string))].sort((a, b) => a.localeCompare(b));
  return { plugins: names };
}

async function listDocs(env: Env) {
  const docs = await sb(env, "documents?select=id,title,plugin,kind,source_url,created_at&order=created_at.desc&limit=500");
  return { docs };
}

async function addDoc(env: Env, request: Request) {
  const b = await readJson(request);
  const title = clean(b.title, 200) || "Untitled note";
  const plugin = clean(b.plugin, 100);
  const kind = b.kind === "learned" ? "learned" : "doc";
  const source_url = clean(b.source_url, 500);
  const text = clean(b.text, 200000);
  if (!text) throw new HttpError(400, "Add some text.");
  if (source_url) {
    await deleteWhere(env, `source_url=eq.${enc(source_url)}&plugin=eq.${enc(plugin)}`);
  }
  const id = await createDoc(env, { title, plugin, kind, source_url, text });
  return { id };
}

async function removeDoc(env: Env, url: URL) {
  const id = url.searchParams.get("id") || "";
  if (!UUID.test(id)) throw new HttpError(400, "Missing or invalid id.");
  await deleteWhere(env, `id=eq.${id}`);
  return { ok: true };
}

async function ask(env: Env, request: Request) {
  const b = await readJson(request);
  const question = clean(b.question, 1000);
  const plugin = clean(b.plugin, 100);
  const asReply = b.asReply !== false;
  if (!question) throw new HttpError(400, "Type a question.");

  const rpcRes: Row[] = await sb(env, "rpc/search_chunks", {
    method: "POST",
    body: JSON.stringify({ q: question, p: plugin, n: 6 }),
  });
  const hits: Row[] = (Array.isArray(rpcRes) ? rpcRes : []).filter((h) => Number(h.rank) >= MIN_RANK);
  const found = hits.length > 0;
  await logQuestion(env, question, plugin, found);

  let user = `Question: ${question}`;
  if (plugin) user = `Plugin: ${plugin}\n${user}`;
  if (found) {
    const passages = hits
      .map((h, i) => `[${i + 1}] Document: ${h.title}${h.plugin ? ` (${h.plugin})` : " (shared)"}\n${h.text}`)
      .join("\n\n");
    user = `${user}\n\nPassages:\n${passages}`;
  }
  const answer = await callLlm(env, systemPrompt(found, asReply), user);

  const seen = new Set<string>();
  const sources: Row[] = [];
  for (const h of hits || []) {
    const k = `${h.title}|${h.plugin}`;
    if (seen.has(k)) continue;
    seen.add(k);
    sources.push({ title: h.title, plugin: h.plugin, kind: h.kind });
  }
  return { answer, sources, found };
}

async function learn(env: Env, request: Request) {
  const b = await readJson(request);
  const question = clean(b.question, 500);
  const answer = clean(b.answer, 4000);
  const plugin = clean(b.plugin, 100);
  if (!question || !answer) throw new HttpError(400, "A question and an answer are needed.");
  const title = `Learned: ${question}`.slice(0, 200);
  await deleteWhere(env, `kind=eq.learned&title=eq.${enc(title)}&plugin=eq.${enc(plugin)}`);
  const id = await createDoc(env, { title, plugin, kind: "learned", text: `Question: ${question}\n\nConfirmed answer: ${answer}` });
  return { id };
}

async function top(env: Env, url: URL) {
  const plugin = clean(url.searchParams.get("plugin"), 100);
  const filter = plugin ? `&plugin=eq.${enc(plugin)}` : "";
  const rows = await sb(env, `questions?select=text,plugin,count,found,last_asked&order=count.desc,last_asked.desc&limit=10${filter}`);
  return { top: rows };
}

async function unanswered(env: Env, url: URL) {
  const plugin = clean(url.searchParams.get("plugin"), 100);
  const filter = plugin ? `&plugin=eq.${enc(plugin)}` : "";
  const rows = await sb(env, `questions?select=text,plugin,count,last_asked&found=eq.false&order=count.desc,last_asked.desc&limit=20${filter}`);
  return { unanswered: rows };
}

// ---------- entry point ----------
// One handler, two entry modes: Pages Functions (onRequest) and a Worker
// default export (fetch). In Worker mode anything that is not /api/* is
// served from the static assets binding.

async function handle(request: Request, env: Env): Promise<Response> {
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  try {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
    const m = request.method;

    if (m === "GET" && route === "plugins") return json(await plugins(env));
    if (m === "GET" && route === "docs") return json(await listDocs(env));
    if (m === "POST" && route === "docs") return json(await addDoc(env, request));
    if (m === "DELETE" && route === "docs") return json(await removeDoc(env, url));
    if (m === "POST" && route === "ask") return json(await ask(env, request));
    if (m === "POST" && route === "learn") return json(await learn(env, request));
    if (m === "GET" && route === "top") return json(await top(env, url));
    if (m === "GET" && route === "unanswered") return json(await unanswered(env, url));
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "Not found." }, 404);
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return json({ error: "Something went wrong on the server." }, 500);
  }
}

export const onRequest = async (context: { request: Request; env: Env }): Promise<Response> =>
  handle(context.request, context.env);

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => handle(request, env),
};
