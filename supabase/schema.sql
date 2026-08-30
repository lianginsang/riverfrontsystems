-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- for the Agency Systems landing page lead capture.

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  email text not null,
  brief text not null,
  source text not null default 'agency-systems-landing',
  status text not null default 'new'
);

alter table leads enable row level security;

-- Allows the public site (using the anon key) to insert new leads only.
-- No select/update/delete for anon — you read leads from the Supabase
-- dashboard's Table Editor (or later, your own CRM UI) using your account.
create policy "public can insert leads"
  on leads for insert
  to anon
  with check (true);
