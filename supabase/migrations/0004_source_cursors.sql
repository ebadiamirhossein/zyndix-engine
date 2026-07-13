-- Per-segment Apollo org-search pagination cursor (step 5.2)
-- Apply in Supabase SQL editor.

create table source_cursors (
  segment_key text primary key,
  page int not null default 1,
  updated_at timestamptz default now()
);
