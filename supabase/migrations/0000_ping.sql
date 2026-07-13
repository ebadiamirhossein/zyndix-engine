create table if not exists _ping (
  id uuid primary key default gen_random_uuid(),
  note text,
  created_at timestamptz default now()
);
