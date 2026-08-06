-- =========================================================
-- JAS TECH BILLING — Supabase schema
-- Run this once in Supabase SQL Editor (Project → SQL Editor → New query)
-- Safe to re-run: uses "if not exists" / "or replace" where possible.
-- =========================================================

-- ---------------------------------------------------------
-- 1. PROFILES  (one row per auth user; role + approval status)
-- ---------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default '',
  email       text not null default '',
  role        text not null default 'employee' check (role in ('admin','employee')),
  status      text not null default 'pending'  check (status in ('pending','approved','rejected')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------
-- 2. BILLS  (one row per invoice)
-- ---------------------------------------------------------
create table if not exists public.bills (
  id                bigint generated always as identity primary key,
  invoice_no        text not null,
  customer_name     text default '',
  customer_phone    text default '',
  customer_address  text default '',
  bill_date         date,
  notes             text default '',
  total             numeric(12,2) not null default 0,
  created_by        uuid references public.profiles(id) on delete set null,
  created_by_name   text default '',
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------
-- 3. BILL ITEMS  (line items belonging to a bill)
-- ---------------------------------------------------------
create table if not exists public.bill_items (
  id           bigint generated always as identity primary key,
  bill_id      bigint not null references public.bills(id) on delete cascade,
  item_name    text not null,
  description  text default '',
  serial       text default '',
  qty          numeric not null default 1,
  price        numeric not null default 0,
  amount       numeric not null default 0,
  sort_order   int not null default 0
);

create index if not exists bill_items_bill_id_idx on public.bill_items(bill_id);
create index if not exists bills_invoice_no_idx on public.bills(invoice_no);
create index if not exists bills_customer_name_idx on public.bills(customer_name);
create index if not exists bills_customer_phone_idx on public.bills(customer_phone);

-- Unique invoice numbers
alter table public.bills drop constraint if exists bills_invoice_no_unique;
alter table public.bills add constraint bills_invoice_no_unique unique (invoice_no);

-- ---------------------------------------------------------
-- 4. Auto-create a profile row whenever someone signs up
--    New users start as: role = employee, status = pending
-- ---------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, role, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    'employee',
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------
-- 5. Helper: is the current user an approved admin?
--    (security definer avoids infinite RLS recursion on profiles)
-- ---------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'approved'
  );
$$;

create or replace function public.is_approved()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved'
  );
$$;

-- ---------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.bills      enable row level security;
alter table public.bill_items enable row level security;

-- PROFILES: everyone can read their own row; admins can read/update all rows
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (id = auth.uid());

drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin" on public.profiles
  for select using (public.is_admin());

drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin" on public.profiles
  for update using (public.is_admin());

-- (No insert policy needed — the trigger inserts as the server, bypassing RLS.)

-- BILLS: any approved user (admin or employee) can read & create;
--        only admins can delete. No update policy = bills are immutable once saved.
drop policy if exists "bills_select_approved" on public.bills;
create policy "bills_select_approved" on public.bills
  for select using (public.is_approved());

drop policy if exists "bills_insert_approved" on public.bills;
create policy "bills_insert_approved" on public.bills
  for insert with check (public.is_approved());

drop policy if exists "bills_delete_admin" on public.bills;
create policy "bills_delete_admin" on public.bills
  for delete using (public.is_admin());

-- BILL_ITEMS: same shape as bills
drop policy if exists "bill_items_select_approved" on public.bill_items;
create policy "bill_items_select_approved" on public.bill_items
  for select using (public.is_approved());

drop policy if exists "bill_items_insert_approved" on public.bill_items;
create policy "bill_items_insert_approved" on public.bill_items
  for insert with check (public.is_approved());

drop policy if exists "bill_items_delete_admin" on public.bill_items;
create policy "bill_items_delete_admin" on public.bill_items
  for delete using (public.is_admin());

-- ---------------------------------------------------------
-- 7. Base table grants
--    RLS policies only filter WHICH ROWS a role can see — Postgres
--    separately requires a base GRANT before "authenticated" can
--    touch a table at all. Without this, every query fails with
--    42501 "permission denied", even though the RLS policies above
--    are correct.
-- ---------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select, update on public.profiles to authenticated;
grant select, insert, delete on public.bills to authenticated;
grant select, insert, delete on public.bill_items to authenticated;

grant usage, select on all sequences in schema public to authenticated;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;

-- ---------------------------------------------------------
-- 8. First-time setup: promote yourself to admin
--    Run this ONCE after you register your own account in the app.
--    Replace the email below with the account you signed up with.
-- ---------------------------------------------------------
-- update public.profiles
-- set role = 'admin', status = 'approved'
-- where email = 'you@example.com';