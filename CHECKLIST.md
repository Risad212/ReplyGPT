# Ask Desk — Action checklist

Do the items in order. Tick them off as you go.

## Urgent (10 minutes, protect the tool)
- [ ] 1. Cloudflare Access on the whole site
      Dashboard → Zero Trust → Access → Applications → Add an application →
      Self-hosted → your site domain → policy: allow your team emails.
- [ ] 2. Rate limiting on the API
      Dashboard → your site → Security → WAF → Rate limiting rules →
      Create rule: path starts with `/api/`, more than ~30 requests per minute
      per IP → Block.
- [ ] 3. AI spending cap
      Groq console (or your LLM provider) → set a monthly limit + alert email.

## One-time setup for the brain (if not done yet)
- [ ] 4. Supabase → SQL Editor → paste all of `COPY-THIS.sql` → Run →
      expect "Success. No rows returned".
- [ ] 5. Cloudflare → Workers & Pages → ask-desk → Settings → Bindings →
      Add → Workers AI → variable name exactly `AI` → Save.
- [ ] 6. Backfill old documents:
      `./scripts/backfill.sh https://YOUR-SITE.pages.dev`
      Repeat until it prints "All done."

## Test after setup
- [ ] 7. Ask: `can I get my money back?` → should find the refund page
      (no word "refund" in the question) with a clickable source.
- [ ] 8. Ask: `Does WP Smart Pay support Tutor LMS?`
- [ ] 9. Ask: `How much does WP Smart Pay Pro cost and what's included?`
- [ ] 10. Ask: `My Paddle payment is not working, what should I do?`

## Weekly routine (10 minutes, makes it smarter every week)
- [ ] Run `./scripts/counts.sh https://YOUR-SITE.pages.dev`
- [ ] Look at the unanswered list → answer the top ones yourself in the chat
      → click "Correct it" → save. Learned answers always win from now on.
- [ ] Glance at the newest learned answers for mistakes.

## Optional upgrades (say the word, I build)
- [ ] Thumbs up / down on answers → feeds the unanswered report
- [ ] Suggested follow-up questions under each answer
- [ ] Team logins with roles (Phase 7)
- [ ] Customer-facing mode with stricter guardrails (Phase 7)
- [ ] ThriveDesk widget (Phase 7)

## Safety rules for the team (share this)
- Read every reply before sending it to a customer.
- Never trust prices, refund amounts or integration claims without checking
  the linked source.
- Never paste customer personal data into the chat.
