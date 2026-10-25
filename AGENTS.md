# Ask Desk: build spec for OpenCode

Read this file first. It is the full brief. Build the project in small steps, in the order of the task list below, and keep the code simple and light.

## What this is
A small internal support tool. A support agent picks a **plugin**, types a customer's question, and gets a short, ready-to-send reply written from the team's own documents. Agents can correct answers, and the tool remembers the corrections. It also counts the most asked questions.

The company sells several plugins (a WordPress payment plugin is the first; later a SaaS tool and a Joomla extension). Knowledge for one plugin must never leak into another. Shared info (refunds, licensing, payment) has no plugin name and applies to all.

## Hard rules
1. **Fully open-source code, no self-hosting.** Use only managed free tiers: Cloudflare Pages + Pages Functions, Supabase (Postgres), a hosted open-model API, GitHub Actions. No servers to run.
2. **No build step for the front end.** One static `public/index.html` with plain JS and CSS. No React, no bundler.
3. **No secrets in the browser.** API keys live only in Cloudflare environment variables. The browser sends only the team access key.
4. **Answer only from retrieved passages.** If nothing relevant is found, say so. Then give a clearly marked general-knowledge answer, or say it does not know. Never invent plugin features, integrations or prices.
5. **Learned answers win.** Passages from corrected answers (`kind = 'learned'`) rank above normal documents when they conflict.
6. **Bangla must work.** Queries and documents may be in Bangla or English.
7. **Keep it light.** No heavy frameworks. Small files. Plain `fetch`.

## Stack
- Front end: `public/index.html` (static).
- API: Cloudflare Pages Functions in `functions/api/[[route]].ts` (TypeScript, no framework, plain `fetch` to Supabase REST and the LLM).
- Database: Supabase Postgres. Phase 1 search uses Postgres full-text search (no embeddings). Add pgvector later only if needed.
- LLM: any **OpenAI-compatible** chat-completions endpoint, set by `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (Groq, Together, Fireworks or OpenRouter, with Llama 3.x or Qwen 2.5).
- Crawler: `crawler/crawl.py` (Python, trafilatura), run weekly by GitHub Actions.

## Environment variables (Cloudflare Pages)
See `.env.example`: `TEAM_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`.

## Data model
Already written in `supabase/schema.sql`: `documents`, `chunks` (with full-text column), `questions`, and the `search_chunks` function. Do not change the schema without explaining why.

## API contract
All routes live under `/api/` and need the header `Authorization: Bearer <TEAM_KEY>`. Return JSON. Return `401` for a wrong key. The chat page uses `plugins`, `ask` and `learn`; the rest are for curl, scripts and the crawler.

| Method and path | Purpose |
|---|---|
| `GET /api/plugins` | Distinct plugin names from `documents` (excluding blank). |
| `GET /api/docs` | List documents: id, title, plugin, kind, source_url, created_at. API-only. |
| `POST /api/docs` | Body `{title, plugin, kind?, source_url?, text}`. Split `text` into chunks of about 700 to 1200 characters on blank lines. Insert the document and its chunks. If `source_url` already exists for the same plugin, replace the old document (used by the crawler). API-only. |
| `DELETE /api/docs?id=<uuid>` | Delete a document (chunks cascade). API-only. |
| `POST /api/ask` | Body `{question, plugin?, asReply?}`. Search chunks, call the LLM, log the question. Return `{answer, sources:[{title, plugin, kind}], found:boolean}`. |
| `POST /api/learn` | Body `{question, answer, plugin}`. Save as a `kind='learned'` document titled `Learned: <question>` (replace one with the same title and plugin). |
| `GET /api/top?plugin=` | Top 10 most asked questions: text, count, last_asked. API-only. |
| `GET /api/unanswered?plugin=` | Questions with no matching document: text, count, last_asked. API-only. |

### `/api/ask` logic
1. Normalize the question (lowercase, trim). Upsert it into `questions` (increase `count`, set `last_asked`).
2. Call the SQL function `search_chunks(q, plugin, 6)`. It returns matching chunks from that plugin plus shared (blank plugin) documents, learned answers boosted.
3. If no chunks come back: `found=false`. Ask the LLM to say the documents do not cover it and to give a short, clearly labelled general-knowledge answer only if it is safe.
4. If chunks come back: `found=true`. Send them as numbered passages with their document titles.
5. System prompt (keep it short): answer only from the passages; name the document used; if `asReply`, write a short, friendly message the agent can send to the customer; if the passages conflict, trust `Learned:` ones; never invent features, versions, prices or integrations.
6. Set a request timeout and return a clear error message if the LLM call fails.

## Front end (`public/index.html`) — chat only
The page is a single-column chat that looks like a minimal ChatGPT: header, centered greeting, and one pill-shaped composer at the bottom (text input + round arrow button, a small disclaimer line under it). There is no admin/sources panel, no upload, no document management in the UI: documents arrive through the crawler or `POST /api/docs` (curl, task 6 tooling later).
- Plugin control lives in the header: with zero plugins the header shows "All documents"; with exactly one plugin it shows that name and there is no dropdown; with several plugins a small header dropdown appears (remembered in `localStorage`). Every ask sends the selected plugin.
- Leak rule: when at least one plugin exists, there is no "all plugins" option for asking. Blank plugin (search everything) is allowed only while no plugin documents exist at all.
- Under each answer: sources used, **Copy** (copies just the reply text, never on error messages), **Correct it** (editable text, then save through `/api/learn`; the corrected text replaces the reply in the chat).
- First visit asks for the team access key in a small overlay and keeps it in `localStorage` (`askdesk.key`). The key is never hardcoded in the page. A `401` — or any failure to reach the API — clears the stored key and re-opens the overlay with a clear message.
- Light and dark themes through CSS variables and `prefers-color-scheme`. Keyboard focus visible. No horizontal scrolling at 360px.
- Colors: accent `#1f6b5a` (light) and `#5fc2a8` (dark). Font: IBM Plex Sans with a system fallback.

## Crawler (`crawler/crawl.py`)
- Inputs from environment: `API_URL`, `TEAM_KEY`, and a `crawler/sites.json` list like `[{"plugin": "WP Smart Pay", "sitemap": "https://example.com/sitemap.xml"}]`.
- For each site: read the sitemap, fetch each page, extract clean text with trafilatura, skip pages under 200 characters, then `POST /api/docs` with `source_url` set so re-runs replace old versions.
- Be polite: delay between requests, a clear user agent, respect `robots.txt`.
- `.github/workflows/crawl.yml` runs it weekly and on demand, with secrets from GitHub.

## Current state
Tasks 1 (schema), 2 (API), 3 (page) and 5 (crawler) are written. The page is chat-only: plugin dropdown, key overlay, sources, copy and "Correct it" (learn) are in; the admin/sources panel was deliberately dropped — chat is the whole app. Everything is checked against fakes only. `/api/unanswered` is in the contract (questions with no matching document). Task 4 onward needs a real Supabase project and AI key. Run `node tests/api.test.mjs` after any API change.

## Task list (do in order, test each one)
1. Create the Supabase project, run `supabase/schema.sql`, and confirm `search_chunks('refund policy', 'WP Smart Pay', 6)` runs.
2. Implement `functions/api/[[route]].ts` with the contract above. Add a small `tests/` script or `curl` examples in the README.
3. Build `public/index.html` against the API.
4. Test with 20 sample documents and 10 real questions in English and Bangla. Fix retrieval problems (term matching, chunk size, ranking).
5. Write the crawler and workflow.
6. Curl-only tooling for counts (optional): a small script or shortcut that prints `GET /api/top` and `GET /api/unanswered`. No UI.
7. Later, only if needed: login with roles through Supabase Auth, and pgvector search.

## Definition of done
- A support agent can open the page, pick a plugin, ask a question and copy a reply in under a minute.
- Wrong or missing information is never invented.
- Works at 360px wide and on desktop.
- README lets a non-developer deploy it in under 30 minutes.
