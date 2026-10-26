# Ask Desk — Roadmap to a powerful, ChatGPT-type support tool

The goal: ChatGPT's feel and smartness, but every answer grounded in the team's own
documents. Free tiers only, no servers, one light HTML file, no frameworks.

Phases ship and get tested one at a time, in this order.

---

## Phase 1 — The ChatGPT feel  (most visible, ~1 session)
1. **Streaming answers** — the reply appears word-by-word while the AI writes
   (API streams, page renders live). Plus a **Stop** button.
2. **Markdown answers** — bold, bullet lists, numbered steps render properly.
3. Keep: sources under every answer, Copy, Correct it.

## Phase 2 — Conversations  (~1 session)
4. **Sidebar with saved chats** — New chat button, revisit old conversations.
   Stored in the browser (localStorage) — zero server cost, private to the agent.
5. **Full conversation memory** — the whole thread is sent with each question,
   not just the last 6 messages.

## Phase 3 — The brain  (the real smartness, ~1–2 sessions)
6. **Semantic search (pgvector)** — embeddings understand *meaning*:
   "can I get my money back?" finds the refund page without the word "refund".
   - add a `vector` column + embedding step on document save
   - search = meaning match first, keyword match as backup
   - needs a free/cheap embedding API (e.g. OpenAI-compatible embedding endpoint)
7. **Smart retry** — if search finds nothing, rewrite the question into better
   keywords and search once more before saying "not found".

## Phase 4 — Knowledge expansion  (data quality)
8. Crawl remaining useful pages: full changelog entries, use-cases, testing docs.
9. Bangla content: if the team has Bangla docs/FAQs, add them as documents.
10. Not crawlable (accepted): AppSumo Q&A (JavaScript-only), private Facebook
    groups. WordPress.org forum + reviews already cover customer sentiment.
11. Weekly routine: review `./scripts/counts.sh` output → write learned answers
    for the top unanswered questions → the tool improves every week.

## Phase 5 — Agent workflow polish  (small, high value)
12. **Clickable sources** — each source links to the real page for 1-click verify.
13. **Answer confidence wording** — "from the docs" vs "best guess, verify" tone.
14. **Tone preset** — optional formal/friendly toggle per agent.

## Phase 6 — Trust, safety, scale  (before wider team use)
15. Cloudflare rate limiting on /api/* (checklist item, one dashboard click).
16. Cloudflare Access for the whole site (each teammate signs in with email).
17. AI provider spending cap + alerts.
18. Supabase weekly backup + one restore test.

## Phase 7 — Later, only if needed
19. Team logins with roles (Supabase Auth).
20. Customer-facing mode (public help assistant with stricter guardrails).
21. Other channels: email/WhatsApp replies, or a widget inside ThriveDesk
    (the team's own product — natural fit).

---

## Success measures
- 8 of 10 real customer questions answered correctly from documents.
- "Not found" list shrinks week over week (unanswered → learned).
- An agent can copy a ready-to-send reply in under a minute.

## Rules that never change
- Answer only from retrieved passages; never invent features/prices.
- Learned (corrected) answers always win.
- Plugins never leak into each other.
- No secrets in the browser; no login for the chat itself.
