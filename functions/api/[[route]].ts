// Ask Desk API. One Cloudflare Pages Function that handles every /api/* request.
// Talks to Supabase through its REST interface and to any OpenAI-compatible LLM endpoint.

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  LLM_API_KEY: string;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  AI?: { run: (model: string, input: { text: string[] }) => Promise<{ data?: number[][] }> };
  ADMIN_KEY?: string;
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
const SEM_MIN = 0.35;
const EMBED_MODEL = "@cf/baai/bge-m3";
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

// Embeddings via the Cloudflare AI binding (free tier). Returns [] when the
// binding is missing or fails — keyword search still works without it.
async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (!env.AI || !texts.length) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    try {
      const res = await env.AI.run(EMBED_MODEL, { text: texts.slice(i, i + 16) });
      if (Array.isArray(res?.data)) out.push(...res.data);
      else return out;
    } catch {
      return out;
    }
  }
  return out;
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
  const inserted: Row[] = [];
  try {
    for (let i = 0; i < rows.length; i += 200) {
      const part: Row[] = await sb(env, "chunks", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(rows.slice(i, i + 200)),
      });
      inserted.push(...(part || []));
    }
  } catch (e) {
    await sb(env, `documents?id=eq.${id}`, { method: "DELETE" }).catch(() => {});
    throw e;
  }
  try {
    const vecs = await embed(env, inserted.map((r) => String(r.text || "")));
    for (let i = 0; i < inserted.length; i++) {
      if (!vecs[i]) continue;
      await sb(env, `chunks?id=eq.${inserted[i].id}`, {
        method: "PATCH",
        body: JSON.stringify({ embedding: JSON.stringify(vecs[i]) }),
      });
    }
  } catch {}
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

function systemPrompt(mode: "found" | "notfound" | "smalltalk", asReply: boolean, tone: string): string {
  const persona = [
    "You are the support assistant for a team that sells WordPress payment plugins (WP Smart Pay and its Paddle add-ons).",
    "Voice: a warm, experienced support person. Plain words, short paragraphs. No corporate stiffness, no emoji.",
    tone === "formal"
      ? "Register: formal and professional. Avoid contractions. In Bangla, use the polite form."
      : "Register: friendly and natural.",
    "Never claim to be a human and never make up a name for yourself.",
    "Answer in the same language as the question (English or Bangla).",
  ];
  const style = asReply
    ? "The reply will be sent to a customer as it is: briefly acknowledge their question in a natural way, answer clearly in short paragraphs, and end with one helpful next step or an offer to help further. No greeting line with a name, no signature."
    : "Write a short, plain answer for the support agent.";
  if (mode === "found") {
    return [
      ...persona,
      "Use ONLY the numbered passages you are given. Do not add features, versions, prices, integrations or policies that the passages do not state.",
      "Passages from documents titled 'Learned:' are answers the team confirmed. If passages conflict, trust the 'Learned:' ones.",
      "If the passages only partly answer the question, give the part they support and say what is missing.",
      "If the passages do not answer the question at all, say in one short sentence that the documents do not cover it, suggest checking the plugin documentation or asking a teammate, and cite no documents.",
      "When you do use passages, end with the document title you used in brackets, like [Refund policy]. Never write a placeholder instead of a real title.",
      style,
    ].join("\n");
  }
  if (mode === "notfound") {
    return [
      ...persona,
      "The team's documents did not contain anything relevant to this question.",
      "Say so in one or two warm sentences — you could not find it in the documents and will check with the team — and suggest the agent check the plugin documentation or ask a teammate.",
      "If the question is too vague to even tell what is being asked, instead ask one short clarifying question.",
      "Never guess about the company's own plugins: no features, integrations, prices, versions or policies.",
      "Only if the question is general knowledge unrelated to the company's products, add a short answer labelled 'General knowledge (not from your documents):'.",
      style,
    ].join("\n");
  }
  return [
    ...persona,
    "This message is a greeting or a thank-you, not a real question.",
    "Reply warmly in one or two short sentences and offer to help.",
    "Do not mention documents.",
    style,
  ].join("\n");
}

const SMALL_TALK = new Set([
  "hi", "hii", "hiii", "hello", "hello there", "hey", "hey there", "yo",
  "thanks", "thank you", "thx", "ty", "many thanks", "thanks a lot",
  "bye", "goodbye", "good morning", "good afternoon", "good evening",
  "হাই", "হ্যালো", "ধন্যবাদ", "অনেক ধন্যবাদ", "সালাম", "আসসালামু আলাইকুম", "বাই",
]);

function isSmallTalk(q: string): boolean {
  const t = normalize(q).replace(/[!.?,:;]+/g, "").trim();
  return t.length <= 30 && SMALL_TALK.has(t);
}

function readHistory(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.slice(-24)
    .map((m: any) => `${m && m.role === "assistant" ? "Assistant" : "Agent"}: ${clean(m && m.content, 800)}`)
    .filter((l) => l.length > 10);
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
  const p = await prepareAsk(env, request);
  const answer = await callLlm(env, systemPrompt(p.mode, p.asReply, p.tone), p.user);
  return { answer, sources: p.sources, found: p.found, confidence: p.confidence };
}

async function prepareAsk(env: Env, request: Request) {
  const b = await readJson(request);
  const question = clean(b.question, 1000);
  const plugin = clean(b.plugin, 100);
  const asReply = b.asReply !== false;
  const tone = b.tone === "formal" ? "formal" : "friendly";
  if (!question) throw new HttpError(400, "Type a question.");

  const hist = readHistory(b.history);

  if (isSmallTalk(question)) {
    await logQuestion(env, question, plugin, true);
    let user = hist.length ? `Earlier conversation:\n${hist.join("\n")}\n\n` : "";
    user += `Question: ${question}`;
    return { asReply, tone, mode: "smalltalk" as const, user, sources: [] as Row[], found: true, confidence: "high" };
  }

  const rpcRes: Row[] = await sb(env, "rpc/search_chunks", {
    method: "POST",
    body: JSON.stringify({ q: question, p: plugin, n: 6 }),
  });
  let hits: Row[] = (Array.isArray(rpcRes) ? rpcRes : []).filter((h) => Number(h.rank) >= MIN_RANK);

  // Semantic pass: matches by meaning, so it also rescues questions the
  // keyword search missed. Best rank wins per chunk; keep the top 6.
  const vec = (await embed(env, [question]))[0];
  if (vec) {
    try {
      const sem: Row[] = await sb(env, "rpc/search_chunks_semantic", {
        method: "POST",
        body: JSON.stringify({ q_embedding: JSON.stringify(vec), p: plugin, n: 6 }),
      });
      const best = new Map<string, Row>();
      for (const h of [...hits, ...(Array.isArray(sem) ? sem : [])]) {
        if (!h || h.rank == null || !h.text || h.title === undefined) continue;
        const fromKeyword = hits.includes(h);
        if (!fromKeyword && Number(h.rank) < SEM_MIN) continue;
        const k = String(h.chunk_id);
        const prev = best.get(k);
        if (!prev || Number(h.rank) > Number(prev.rank)) best.set(k, h);
      }
      hits = [...best.values()]
        .filter((h) => Number(h.rank) >= MIN_RANK)
        .sort((a, b) => Number(b.rank) - Number(a.rank))
        .slice(0, 6);
    } catch {}
  }
  // Smart retry: if nothing matched, ask the LLM to rewrite the question into
  // search keywords and try once more. Cuts 'not found' answers.
  if (!hits.length) {
    try {
      const rewrite = await callLlm(env,
        "Rewrite the user's question into 3-6 short search keywords or phrases that would match a support knowledge base. Output only the keywords, comma-separated. No explanation, no punctuation other than commas.",
        `Question: ${question}`);
      const q2 = rewrite.trim().slice(0, 300);
      if (q2 && q2 !== question) {
        const r2 = await sb(env, "rpc/search_chunks", { method: "POST", body: JSON.stringify({ q: q2, p: plugin, n: 6 }) });
        let h2: Row[] = (Array.isArray(r2) ? r2 : []).filter((h) => Number(h.rank) >= MIN_RANK);
        const v2 = (await embed(env, [q2]))[0];
        if (v2) {
          try {
            const s2: Row[] = await sb(env, "rpc/search_chunks_semantic", { method: "POST", body: JSON.stringify({ q_embedding: JSON.stringify(v2), p: plugin, n: 6 }) });
            const best = new Map<string, Row>();
            for (const h of [...h2, ...(Array.isArray(s2) ? s2 : [])]) {
              if (!h || h.rank == null || !h.text || h.title === undefined) continue;
              const fromKeyword = h2.includes(h);
              if (!fromKeyword && Number(h.rank) < SEM_MIN) continue;
              const k = String(h.chunk_id);
              const prev = best.get(k);
              if (!prev || Number(h.rank) > Number(prev.rank)) best.set(k, h);
            }
            h2 = [...best.values()].filter((h) => Number(h.rank) >= MIN_RANK).sort((a, b) => Number(b.rank) - Number(a.rank)).slice(0, 6);
          } catch {}
        }
        if (h2.length) hits = h2;
      }
    } catch {}
  }
  const found = hits.length > 0;
  await logQuestion(env, question, plugin, found);

  let user = hist.length ? `Earlier conversation:\n${hist.join("\n")}\n\n` : "";
  user += `Question: ${question}`;
  if (plugin) user = `Plugin: ${plugin}\n${user}`;
  if (found) {
    const passages = hits
      .map((h, i) => `[${i + 1}] Document: ${h.title}${h.plugin ? ` (${h.plugin})` : " (shared)"}\n${h.text}`)
      .join("\n\n");
    user = `${user}\n\nPassages:\n${passages}`;
  }
  const seen = new Set<string>();
  const sources: Row[] = [];
  for (const h of hits || []) {
    const k = `${h.title}|${h.plugin}`;
    if (seen.has(k)) continue;
    seen.add(k);
    sources.push({ title: h.title, plugin: h.plugin, kind: h.kind, doc_id: h.doc_id });
  }
  // Attach source links so the chat can show clickable citations.
  if (sources.length) {
    try {
      const ids = [...new Set(sources.map((s) => String(s.doc_id)))].filter((x) => UUID.test(x));
      if (ids.length) {
        const docs: Row[] = await sb(env, `documents?select=id,source_url&id=in.(${enc(ids.join(","))})`);
        const urlById = new Map((Array.isArray(docs) ? docs : []).map((d) => [String(d.id), d.source_url]));
        for (const s of sources) s.source_url = urlById.get(String(s.doc_id)) || null;
      }
    } catch {}
  }
  const topRank = Math.max(0, ...hits.map((h) => Number(h.rank) || 0));
  const confidence = found ? (topRank >= 0.15 ? "high" : "low") : "none";
  return { asReply, tone, mode: found ? ("found" as const) : ("notfound" as const), user, sources, found, confidence };
}

async function callLlmStream(env: Env, system: string, user: string, onDelta: (t: string) => void): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        temperature: 0.2,
        max_tokens: 500,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok || !res.body) throw new HttpError(502, `The AI service returned an error (${res.status}). Check LLM_BASE_URL, LLM_MODEL and LLM_API_KEY.`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const t = j?.choices?.[0]?.delta?.content;
          if (t) {
            full += t;
            onDelta(t);
          }
        } catch {}
      }
    }
    if (!full.trim()) throw new HttpError(502, "The AI service sent an empty answer.");
    return full.trim();
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    if (e?.name === "AbortError") throw new HttpError(504, "The AI service took too long. Try again.");
    throw new HttpError(502, "Could not reach the AI service.");
  } finally {
    clearTimeout(timer);
  }
}

async function askStream(env: Env, request: Request): Promise<Response> {
  const p = await prepareAsk(env, request);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      try {
        send({ type: "meta", found: p.found, sources: p.sources, confidence: p.confidence });
        await callLlmStream(env, systemPrompt(p.mode, p.asReply, p.tone), p.user, (t) => send({ type: "delta", text: t }));
        send({ type: "done" });
      } catch (e: any) {
        send({ type: "error", message: e instanceof HttpError ? e.message : "Something went wrong while answering." });
      } finally {
        ctrl.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

async function backfill(env: Env) {
  const rows: Row[] = await sb(env, "chunks?embedding=is.null&select=id,text&limit=100");
  if (!rows || !rows.length) return { updated: 0, more: false };
  const vecs = await embed(env, rows.map((r) => String(r.text || "")));
  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!vecs[i]) continue;
    await sb(env, `chunks?id=eq.${rows[i].id}`, {
      method: "PATCH",
      body: JSON.stringify({ embedding: JSON.stringify(vecs[i]) }),
    });
    updated++;
  }
  const more: Row[] = await sb(env, "chunks?embedding=is.null&select=id&limit=1");
  return { updated, more: Array.isArray(more) && more.length > 0 };
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

    // Optional lock on document changes and backfill. Set ADMIN_KEY in the
    // Cloudflare variables to turn this on; the crawler sends the same key
    // as a Bearer token. The chat itself never needs a key.
    if (env.ADMIN_KEY) {
      const guarded =
        (m === "POST" && (route === "docs" || route === "backfill")) ||
        (m === "DELETE" && route === "docs");
      if (guarded && request.headers.get("Authorization") !== `Bearer ${env.ADMIN_KEY}`) {
        return json({ error: "Unauthorized." }, 401);
      }
    }

    if (m === "GET" && route === "plugins") return json(await plugins(env));
    if (m === "GET" && route === "docs") return json(await listDocs(env));
    if (m === "POST" && route === "docs") return json(await addDoc(env, request));
    if (m === "DELETE" && route === "docs") return json(await removeDoc(env, url));
    if (m === "POST" && route === "ask") return json(await ask(env, request));
    if (m === "POST" && route === "ask/stream") return askStream(env, request);
    if (m === "POST" && route === "backfill") return json(await backfill(env));
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
