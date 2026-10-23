-- Ask Desk schema. Run once in the Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  plugin      text not null default '',          -- '' = shared by all plugins
  kind        text not null default 'doc' check (kind in ('doc', 'learned')),
  source_url  text,                               -- set by the crawler
  created_at  timestamptz not null default now()
);

create table if not exists chunks (
  id        bigserial primary key,
  doc_id    uuid not null references documents(id) on delete cascade,
  plugin    text not null default '',
  kind      text not null default 'doc',
  text      text not null,
  fts       tsvector generated always as (to_tsvector('simple', text)) stored
);

create table if not exists questions (
  key         text primary key,                   -- normalized question + plugin
  text        text not null,
  plugin      text not null default '',
  count       integer not null default 1,
  found       boolean not null default true,      -- false = no passages matched
  last_asked  timestamptz not null default now()
);

create index if not exists chunks_fts_idx    on chunks using gin (fts);
create index if not exists chunks_plugin_idx on chunks (plugin);
create index if not exists docs_source_idx   on documents (plugin, source_url);

-- Lock the tables. Only the server (service key) reads or writes them.
alter table documents enable row level security;
alter table chunks    enable row level security;
alter table questions enable row level security;

-- Search: matches any word of the question, within the chosen plugin plus shared
-- documents. Words match by prefix, so 'refund' finds 'refunds'. Learned answers are boosted. Works for English and Bangla ('simple' config).
create or replace function search_chunks(q text, p text default '', n int default 6)
returns table (chunk_id bigint, doc_id uuid, title text, plugin text, kind text, text text, rank real)
language sql stable as $$
  with terms as (
    select string_agg(quote_literal(w) || ':*', ' | ') as tsq
    from (
      select distinct lower(w) as w
      from regexp_split_to_table(q, '[^[:alnum:]ঀ-৿]+') as w
      where length(w) > 2
        and lower(w) not in ('the','and','you','your','are','for','with','this','that','what','how','does','can','any','have','has','not','from','about','which','who','when','where','why')
    ) s
  )
  select c.id, c.doc_id, d.title, c.plugin, c.kind, c.text,
         (ts_rank(c.fts, to_tsquery('simple', t.tsq))
           * case when c.kind = 'learned' then 2.0 else 1.0 end)::real as rank
  from chunks c
  join documents d on d.id = c.doc_id
  cross join terms t
  where t.tsq is not null
    and (coalesce(p, '') = '' or c.plugin = p or c.plugin = '')
    and c.fts @@ to_tsquery('simple', t.tsq)
  order by rank desc
  limit n;
$$;
