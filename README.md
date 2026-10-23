# Ask Desk

A small support tool: pick a plugin, ask a customer's question, get a reply written from your own documents. Corrections are remembered and the most asked questions are counted.

Open-source code, no servers to run: Cloudflare Pages (site and API), Supabase (database), a hosted open-model API, GitHub Actions (weekly website crawl).

## Status
Built: database schema, API, web page, website crawler and weekly workflow. Checked locally: the search function on Postgres (English and Bangla), the API against a fake database and fake AI (`node tests/api.test.mjs`, Node 22.18 or newer), and the page at desktop and phone width with a fake API.

Not yet tried: a real Supabase project, a real AI provider, Cloudflare deployment and the crawler on a real site. Do the setup below, then work through tasks 4 to 7 in `AGENTS.md` (test with real questions, tune search, per-plugin counts, optional login and vector search). OpenCode can help: "Read AGENTS.md and do task 4."

## Setup (once the code is finished)
1. **Supabase:** create a free project, open the SQL editor, run `supabase/schema.sql`.
2. **LLM key:** create an API key at a provider with an open model (Groq, Together, Fireworks or OpenRouter).
3. **GitHub:** push this folder to a new repository.
4. **Cloudflare Pages:** connect the repository. Build command: none. Output directory: `public`. Add the variables from `.env.example`.
5. Open the site, enter your `TEAM_KEY`, add your first documents and ask a question.
6. **Weekly crawl (optional):** add `API_URL` and `TEAM_KEY` as GitHub repository secrets, and list your sites in `crawler/sites.json`.

## Before going live (checklist)
1. Put the whole site behind **Cloudflare Access** (Zero Trust, free for small teams) so each person signs in with their work email. Keep `TEAM_KEY` as a second layer.
2. Add a **Cloudflare rate limiting rule** on `/api/*`.
3. Set a **monthly spending limit and alerts** at the AI provider.
4. Make `TEAM_KEY` a random string of 32+ characters. Store it only in Cloudflare and GitHub secrets. Change it whenever someone leaves.
5. Keep the GitHub repository **private**. Turn on two-step login for GitHub, Cloudflare, Supabase and the AI provider.
6. Turn on **Supabase backups** (or export the tables weekly) and test a restore once.
7. Use a custom domain. HTTPS is automatic on Cloudflare.
8. Do not put customers' personal data, passwords or keys in documents or questions.
9. Tell agents to read every reply before sending it, especially prices, integrations and refunds.
10. Review the newest "Learned" answers every week.

`public/_headers` already sets the security headers (content security policy, no framing, no sniffing, HTTPS only). The API sends `Cache-Control: no-store`.

Not included yet: personal logins and roles, an audit log, and a customer-facing mode. See `AGENTS.md` task 7.

## Data tips
- One topic per document. Use `Q:` and `A:` pairs for approved answers.
- Put the plugin name in the "Adding to plugin" field. Leave it blank for shared info (refunds, licensing, payment).
- Do not add customers' personal data.

## License
MIT
