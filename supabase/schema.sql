-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- for the Agency Systems landing page lead capture.

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  phone text not null,
  email text not null,
  preferred_contact text,
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

-- Lets a logged-in Supabase Auth user (you, via admin.html) read leads.
-- Anon (the public site) still cannot read — insert-only, per above.
create policy "authenticated can read leads"
  on leads for select
  to authenticated
  using (true);

-- Lets a logged-in Supabase Auth user (you, via admin.html) delete leads.
-- Anon still cannot delete.
create policy "authenticated can delete leads"
  on leads for delete
  to authenticated
  using (true);


-- ===========================================================================
-- Migration 2: appointment booking
-- ===========================================================================
-- Shared by the AI receptionist (receptionist/, server-side, service role key,
-- which bypasses RLS) and the staff calendar (browser, signed-in staff users).
-- Safe to run more than once. Doesn't modify the leads table above.
--
-- Multi-business ready: every table has business_id. For now there is one
-- business, and business_id defaults to it, so no code has to pass it yet.
-- Adding businesses later means inserting rows into `businesses` and `staff`
-- and having the app pass business_id explicitly.

create extension if not exists btree_gist;

create table if not exists businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- The single business for now, at a fixed id the column defaults point to.
insert into businesses (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Riverfront Systems')
on conflict (id) do nothing;

-- Which Supabase Auth users are staff of which business. Being signed in is
-- not enough to see bookings: the user must also have a row here.
create table if not exists staff (
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null default '00000000-0000-0000-0000-000000000001'
    references businesses (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, business_id)
);

create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default '00000000-0000-0000-0000-000000000001'
    references businesses (id) on delete cascade,
  name text not null,
  duration_minutes integer not null check (duration_minutes between 5 and 480),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Weekly opening hours. weekday: 0 = Sunday ... 6 = Saturday (same as
-- JavaScript's getDay()). Several rows per weekday are allowed for split
-- hours (e.g. 9-12 and 13-17). Times are local to `timezone`.
create table if not exists availability (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default '00000000-0000-0000-0000-000000000001'
    references businesses (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  open_time time not null,
  close_time time not null,
  timezone text not null default 'America/New_York',
  check (close_time > open_time)
);

-- One-off closures: holidays, lunch, time off.
create table if not exists blocked_times (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default '00000000-0000-0000-0000-000000000001'
    references businesses (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null default '00000000-0000-0000-0000-000000000001'
    references businesses (id) on delete cascade,
  service_id uuid not null references services (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  customer_name text not null,
  customer_phone text not null check (customer_phone ~ '^\+[1-9][0-9]{6,14}$'),
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  source text not null check (source in ('ai', 'staff')),
  call_sid text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  -- No double-booking: two 'booked' rows for the same business can't overlap.
  -- '[)' means a 10:00-10:30 booking and a 10:30-11:00 booking don't collide.
  -- Cancelled rows are excluded by the WHERE, so they never block a slot.
  -- A violation raises SQLSTATE 23P01 (exclusion_violation).
  constraint bookings_no_overlap exclude using gist (
    business_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'booked')
);

-- Finding a caller's upcoming bookings by phone, and a day's bookings.
create index if not exists bookings_phone_starts_idx on bookings (customer_phone, starts_at);
create index if not exists bookings_business_starts_idx on bookings (business_id, starts_at);
create index if not exists blocked_times_business_starts_idx on blocked_times (business_id, starts_at);

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bookings_set_updated_at on bookings;
create trigger bookings_set_updated_at
  before update on bookings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- anon (the public site's key): no access to any of these tables.
-- authenticated: only users listed in `staff`, and only their business's rows.
-- service_role (receptionist server): bypasses RLS entirely, so no policies.

-- security definer so policies can check staff without staff's own RLS
-- getting in the way; search_path pinned so it can't be hijacked.
create or replace function is_staff(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff where user_id = auth.uid() and business_id = b
  );
$$;

alter table businesses enable row level security;
alter table staff enable row level security;
alter table services enable row level security;
alter table availability enable row level security;
alter table blocked_times enable row level security;
alter table bookings enable row level security;

drop policy if exists "staff can read their business" on businesses;
create policy "staff can read their business"
  on businesses for select to authenticated
  using (is_staff(id));

drop policy if exists "users can read their own staff rows" on staff;
create policy "users can read their own staff rows"
  on staff for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "staff manage services" on services;
create policy "staff manage services"
  on services for all to authenticated
  using (is_staff(business_id)) with check (is_staff(business_id));

drop policy if exists "staff manage availability" on availability;
create policy "staff manage availability"
  on availability for all to authenticated
  using (is_staff(business_id)) with check (is_staff(business_id));

drop policy if exists "staff manage blocked times" on blocked_times;
create policy "staff manage blocked times"
  on blocked_times for all to authenticated
  using (is_staff(business_id)) with check (is_staff(business_id));

drop policy if exists "staff manage bookings" on bookings;
create policy "staff manage bookings"
  on bookings for all to authenticated
  using (is_staff(business_id)) with check (is_staff(business_id));

-- ---------------------------------------------------------------------------
-- Realtime: lets the staff calendar see April's bookings live.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table bookings;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- After running: make yourself staff (use the email you sign in to admin.html with)
-- ---------------------------------------------------------------------------
-- insert into staff (user_id)
-- select id from auth.users where email = 'you@example.com'
-- on conflict do nothing;

-- Optional starter data (edit, then run). Services and hours can also be
-- managed from the staff calendar once it exists.
-- insert into services (name, duration_minutes) values ('Consultation call', 30);
-- insert into availability (weekday, open_time, close_time)
-- select d, '09:00', '17:00' from generate_series(1, 5) as d;  -- Mon-Fri 9-5
