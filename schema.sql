-- JAS TECH BILLING — DOCUMENTED SUPABASE SCHEMA
-- Inventory: 4 tables, 12 database functions, 9 RLS policies,
-- 5 explicit indexes (plus automatic primary-key indexes), and 3 separately deployed Edge Functions.
--
-- TABLES
-- profiles: one application profile per Supabase Auth user; stores role, approval, and activity/avatar timestamps.
-- bills: one invoice header per saved bill; stores customer, totals, creator, soft-delete state, and public QR token.
-- bill_items: invoice line items linked to bills by invoice_no; deleting a bill cascades to its items.
-- supabase_heartbeat: one service-maintained status row for scheduled heartbeat and cleanup operations.

-- Table: one profile per Auth user; stores identity, role, approval, and account activity metadata.
create table if not exists public.profiles (
  id uuid primary key
    references auth.users(id)
    on delete cascade, name text not null default '',
  email text not null default '', role text not null default 'employee'
    check (role in ('super_admin', 'admin', 'employee')), status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(), last_sign_in_at TIMESTAMPTZ DEFAULT NULL,
  last_activity_at TIMESTAMPTZ DEFAULT NULL, avatar_updated_at timestamptz default null ),
  push_id JSONB DEFAULT NULL, device_data JSONB DEFAULT NULL;

-- Table: one invoice header per saved bill, including customer details, totals, creator, soft-delete time, and public token.
create table if not exists public.bills (
  invoice_no text primary key, customer_name text default '',
  customer_phone text default '', customer_address text default '',
  bill_date date, notes text default '',
  include_notes boolean not null default false, show_watermark boolean not null default false,
  show_qr boolean not null default false, show_signature boolean not null default false,
  total numeric(12,2) not null default 0
    check (total >= 0), created_by uuid
    references public.profiles(id)
    on delete set null, created_by_name text default '',
  created_at timestamptz not null default now(), deleted_at timestamptz default null,
  public_token text );

-- Table: invoice product/service rows linked to the parent bill through invoice_no.
create table if not exists public.bill_items (
  invoice_no text not null
    references public.bills(invoice_no)
    on delete cascade, item_name text not null, description text default '', serial text default '',
  qty numeric not null default 1
    check (qty > 0), price numeric not null default 0
    check (price >= 0), amount numeric not null default 0
    check (amount >= 0) );

-- Table: singleton service-role status row for scheduled heartbeat and cleanup reporting.
create table if not exists public.supabase_heartbeat (
 id                integer primary key default 1 check (id = 1),
  last_ping         text,

  users_status      text,      -- success | partial | failed
  users_purged      integer,
  users_error       text,

  bills_status      text,
  bills_purged      integer,
  bills_error       text,

  reminders_status  text,
  reminders_sent    integer,   -- pushes delivered
  reminders_failed  integer,   -- real failures only (not 404/410)
  reminders_cleared integer,   -- dead devices removed (user turned off notifications)
  reminders_paused integer;
  reminders_error   text,

insert into public.supabase_heartbeat (id)
values (1)
on conflict (id) do nothing;


CREATE TABLE IF NOT EXISTS public.reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES auth.users(id)
        ON DELETE CASCADE,

    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',

    remember_date DATE NOT NULL,

    -- NULL = repeater OFF
    -- daily, weekly, monthly, yearly
    -- Numeric string 1-365 = custom day interval
    repeater TEXT DEFAULT NULL,

    -- Only active or paused
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed')),

    -- Updated when the user clicks Completed
    last_activity DATE DEFAULT NULL,

    CONSTRAINT reminders_repeater_valid CHECK (
        repeater IS NULL
        OR repeater IN ('daily', 'weekly', 'monthly', 'yearly')
        OR repeater ~ '^(?:[1-9]|[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]|36[0-5])$'
    )
);

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reminders_select_own"
ON public.reminders
FOR SELECT
TO authenticated
USING (
    user_id = auth.uid()
    AND public.is_approved()
);

CREATE POLICY "reminders_insert_own"
ON public.reminders
FOR INSERT
TO authenticated
WITH CHECK (
    user_id = auth.uid()
    AND public.is_approved()
);

CREATE POLICY "reminders_update_own"
ON public.reminders
FOR UPDATE
TO authenticated
USING (
    user_id = auth.uid()
    AND public.is_approved()
)
WITH CHECK (
    user_id = auth.uid()
    AND public.is_approved()
);

CREATE POLICY "reminders_delete_own"
ON public.reminders
FOR DELETE
TO authenticated
USING (
    user_id = auth.uid()
    AND public.is_approved()
);

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.reminders
TO authenticated;



CREATE OR REPLACE FUNCTION public.check_reminder_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    reminder_count INTEGER;
    today_date DATE := public.app_today();
BEGIN
    -- Validate date on INSERT or when remember_date changes
    IF TG_OP = 'INSERT'
       OR NEW.remember_date IS DISTINCT FROM OLD.remember_date
    THEN
        IF NEW.remember_date <= today_date THEN
            RAISE EXCEPTION
                'Reminder date must be tomorrow or a future date.';
        END IF;

        IF NEW.remember_date > today_date + 365 THEN
            RAISE EXCEPTION
                'Reminder date cannot be more than one year in the future.';
        END IF;
    END IF;

    -- Enforce reminder limit only on INSERT
    IF TG_OP = 'INSERT' THEN

        PERFORM pg_advisory_xact_lock(
            hashtext(NEW.user_id::TEXT)
        );

        SELECT COUNT(*)
        INTO reminder_count
        FROM public.reminders
        WHERE user_id = NEW.user_id;

        IF reminder_count >= 10 THEN
            RAISE EXCEPTION
                'Maximum 10 reminders allowed per user.';
        END IF;

    END IF;

    RETURN NEW;
END;
$$;

-- Replace the existing trigger
DROP TRIGGER IF EXISTS reminders_limit_trigger
ON public.reminders;

CREATE TRIGGER reminders_limit_trigger
BEFORE INSERT OR UPDATE
ON public.reminders
FOR EACH ROW
EXECUTE FUNCTION public.check_reminder_limit();



GRANT UPDATE ON public.profiles TO service_role;
GRANT UPDATE ON public.reminders TO service_role;

-- Existing trigger remains unchanged
CREATE OR REPLACE TRIGGER reminders_limit_trigger
BEFORE INSERT ON public.reminders
FOR EACH ROW
EXECUTE FUNCTION public.check_reminder_limit();

CREATE OR REPLACE FUNCTION public.app_today()
RETURNS DATE
LANGUAGE SQL
STABLE
AS $$
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date;
$$;

-- Heartbeat needs to read due reminders
GRANT SELECT ON public.reminders TO service_role;

-- FUNCTIONS
revoke all on public.supabase_heartbeat from anon, authenticated;

grant select, update on public.supabase_heartbeat to service_role;

-- Creates a pending employee profile only after the signed-in Auth user's email is verified.
create or replace function public.ensure_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
  declare
  v_user auth.users%rowtype;
  v_profile public.profiles%rowtype;
  begin
    if auth.uid() is null then
      raise exception 'Authentication required';
    end if;
  select *
  into v_user
  from auth.users
  where id = auth.uid();
  if not found then
    raise exception 'Auth user not found';
  end if;
  if v_user.email_confirmed_at is null then
    raise exception 'Email must be verified before a profile can be created';
  end if;
  insert into public.profiles (
  id, name, email, role, status )
  values (
  v_user.id, coalesce(
  v_user.raw_user_meta_data->>'name', split_part(v_user.email, '@', 1)
  ), v_user.email, 'employee', 'pending' )
  on conflict (id)
  do nothing;
  select *
  into v_profile
  from public.profiles
  where id = v_user.id;
  return v_profile;
  end;
$$;

grant execute on function public.ensure_profile()
to authenticated;

revoke execute on function public.ensure_profile()
from anon, public;

-- Returns true only for an approved admin or super_admin; used by admin-only policies and RPCs.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
  select 1
  from public.profiles
  where id = auth.uid()
  and role in ('super_admin', 'admin')
  and status = 'approved' );
$$;

-- Returns true for an approved signed-in user; centralizes the approval check used by RLS and bill creation.
create or replace function public.is_approved()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
  select 1
  from public.profiles
  where id = auth.uid()
  and status = 'approved' );
$$;

-- ROW LEVEL SECURITY, POLICIES AND GRANTS

alter table public.profiles
enable row level security;

alter table public.bills
enable row level security;

alter table public.bill_items
enable row level security;

-- Protect the heartbeat status table; access is granted only to service_role below.
alter table public.supabase_heartbeat
enable row level security;

-- Policy: users can read only their own profile row, enabling their account/profile screen.
drop policy if exists
"profiles_select_own"
on public.profiles;

create policy
"profiles_select_own"
on public.profiles
for select
using (
  id = auth.uid() );

-- Policy: approved admins can read profile rows for user administration.
drop policy if exists
"profiles_select_admin"
on public.profiles;

create policy
"profiles_select_admin"
on public.profiles
for select
using (
  public.is_admin() );

-- Policy: users may update their own row only; column-level GRANTs further restrict writable fields.
create policy
"profiles_update_own"
on public.profiles
for update
using (
  id = auth.uid() )
with check (
  id = auth.uid() );

REVOKE UPDATE ON TABLE public.profiles
FROM PUBLIC, anon, authenticated;

GRANT UPDATE (
    avatar_updated_at,
    last_sign_in_at,
    last_activity_at,
    push_id,
    device_data
)
ON TABLE public.profiles
TO authenticated;

-- Policy: approved users can read invoice headers; pending/rejected users cannot.
drop policy if exists
"bills_select_approved"
on public.bills;

create policy
"bills_select_approved"
on public.bills
for select
using (
  public.is_approved() );

-- Policy: approved users may insert bill headers; create_bill() is the intended atomic app workflow.
drop policy if exists "bills_insert_approved" on public.bills;
create policy "bills_insert_approved"
on public.bills
for insert
to public
with check (public.is_approved());

-- Policy: approved admins can delete invoice headers; foreign-key cascade removes their line items.
drop policy if exists
"bills_delete_admin"
on public.bills;

create policy
"bills_delete_admin"
on public.bills
for delete
using (
  public.is_admin() );

-- Policy: approved users can read invoice line items.
drop policy if exists
"bill_items_select_approved"
on public.bill_items;

create policy
"bill_items_select_approved"
on public.bill_items
for select
using (
  public.is_approved() );

-- Policy: approved users may insert invoice line items; create_bill() is the intended atomic app workflow.
drop policy if exists "bill_items_insert_approved" on public.bill_items;
create policy "bill_items_insert_approved"
on public.bill_items
for insert
to public
with check (public.is_approved());

-- Policy: approved admins can delete invoice line items.
drop policy if exists
"bill_items_delete_admin"
on public.bill_items;

create policy
"bill_items_delete_admin"
on public.bill_items
for delete
using (
  public.is_admin() );

grant usage
on schema public
to authenticated;

grant select, update
on public.profiles
to authenticated;

grant select
on public.bills
to authenticated;

grant select
on public.bill_items
to authenticated;

grant usage, select
on all sequences
in schema public
to authenticated;

-- FUNCTIONS

-- Creates an invoice and its line items atomically, calculates totals, and generates the official daily hexadecimal invoice number.
create or replace function public.create_bill(
  customer_name text, customer_phone text, customer_address text, bill_date date,
  notes text, include_notes boolean, show_watermark boolean, show_qr boolean,
  show_signature boolean, created_by_name text, items jsonb )
returns public.bills
language plpgsql
security definer
set search_path = public
as $$
  declare
  new_bill public.bills%rowtype;
  item jsonb;
  v_invoice_date date := current_date;
  last_no text;
  seq integer := -1;
  hex_seq text;
  v_invoice_no text;
  calculated_total numeric(12,2) := 0;
  item_qty numeric;
  item_price numeric;
  item_amount numeric;
  begin
    if auth.uid() is null then
      raise exception
      'Authentication required.';
    end if;
  if not public.is_approved() then
    raise exception
    'Not authorized to create bills.';
  end if;
  if items is null
    or jsonb_typeof(items) <> 'array'
    or jsonb_array_length(items) = 0 then
    raise exception
    'At least one invoice item is required.';
  end if;
  perform pg_advisory_xact_lock(
  hashtext(
  to_char(
  v_invoice_date, 'YYYYMMDD'
  ) ) );
  select b.invoice_no
  into last_no
  from public.bills b
  where b.invoice_no like
  to_char(
  v_invoice_date, 'YYMMDD'
  ) || '%'
  and char_length(
  b.invoice_no
  ) = 10
  and substring(
  b.invoice_no
  from 7
  for 4
    ) ~ '^[0-9A-Fa-f]{4}$'
    order by b.invoice_no desc
    limit 1;
    if last_no is not null then
      seq :=
      get_byte(
      decode(
      substring(
      last_no
      from 7
      for 4 ), 'hex' ), 0
        ) * 256
        +
        get_byte(
        decode(
        substring(
        last_no
        from 7
        for 4 ), 'hex' ), 1 );
        end if;
      if seq >= 65535 then
        raise exception
        'Daily invoice limit reached (FFFF).';
      end if;
    hex_seq :=
    upper(
    lpad(
    to_hex(
    seq + 1 ), 4, '0'
    ) );
    v_invoice_no :=
    to_char(
    v_invoice_date, 'YYMMDD' )
    ||
    hex_seq;
    for item in
      select value
      from jsonb_array_elements(items)
      loop
        item_qty :=
        coalesce(
        (item->>'qty')::numeric, 0 );
        item_price :=
        coalesce(
        (item->>'price')::numeric, 0 );
        if item_qty <= 0 then
          raise exception
          'Item quantity must be greater than zero.';
        end if;
      if item_price < 0 then
        raise exception
        'Item price cannot be negative.';
      end if;
    item_amount :=
    round(
    item_qty * item_price, 2 );
    calculated_total :=
    calculated_total
    + item_amount;
  end loop;
  calculated_total :=
  round(
  calculated_total, 2 );
  insert into public.bills (
  invoice_no, customer_name, customer_phone, customer_address,
  bill_date, notes, include_notes, show_watermark, show_qr, show_signature, total, created_by,
  created_by_name )
  values (
  v_invoice_no, coalesce(
  customer_name, ''
  ), coalesce(
  customer_phone, ''
  ), coalesce(
  customer_address, ''
  ), bill_date, coalesce(
  notes, ''
  ), coalesce(
  include_notes, true
  ), coalesce(
  show_watermark, true
  ), coalesce(
  show_qr, true
  ), coalesce(
  show_signature, true
  ), calculated_total, auth.uid(), coalesce(
  created_by_name, ''
  ) )
  returning *
  into new_bill;
  for item in
    select value
    from jsonb_array_elements(items)
    loop
      item_qty :=
      (item->>'qty')::numeric;
      item_price :=
      (item->>'price')::numeric;
      item_amount :=
      round(
      item_qty * item_price, 2 );
      insert into public.bill_items (
      invoice_no, item_name, description, serial, qty, price, amount )
      values (
      new_bill.invoice_no, coalesce(
      item->>'item_name', ''
      ), coalesce(
      item->>'description', ''
      ), coalesce(
      item->>'serial', ''
      ), item_qty, item_price, item_amount );
    end loop;
  return new_bill;
  end;
$$;

revoke execute
on function public.create_bill(
  text, text, text, date, text, boolean, boolean, boolean, boolean, text, jsonb )
from public, anon;

grant execute
on function public.create_bill(
  text, text, text, date, text, boolean, boolean, boolean, boolean, text, jsonb )
to authenticated;

-- Checks Auth email existence and confirmation status for the check-email Edge Function; executable only by service_role.
create or replace function public.check_email_exists(check_email text)
returns table(email_exists boolean, confirmed boolean)
language sql
security definer
set search_path = public
as $$
  select true, (email_confirmed_at is not null)
  from auth.users
  where lower(email) = lower(check_email)
  limit 1;
$$;

revoke all on function public.check_email_exists(text) from public;

grant execute on function public.check_email_exists(text) to service_role;

-- Auth before-user-created hook: blocks Google sign-in unless the email already belongs to an existing profile.
create or replace function public.hook_block_new_google_users(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
  declare
  user_email text;
  provider text;
  existing_user boolean;
  begin
    user_email := lower(trim(event->'user'->>'email'));
    provider := lower(coalesce(event->'user'->'app_metadata'->>'provider', ''));
    if provider = 'google' then
      select exists (
      select 1
      from public.profiles
      where lower(email) = user_email )
      into existing_user;
      if not existing_user then
        return jsonb_build_object(
        'error', jsonb_build_object(
        'http_code', 400,
        'message', 'Google sign-in is only available for existing accounts. Please register first.'
        ) );
      end if;
  end if;
  return '{}'::jsonb;
  end;
$$;

grant execute on function public.hook_block_new_google_users(jsonb)
to supabase_auth_admin;

revoke execute on function public.hook_block_new_google_users(jsonb)
from anon, authenticated, public;

-- Finds prior customers by name-word prefix and returns their latest matching contact details for invoice autocomplete.
create or replace function public.search_customers(
  search_text text, result_limit integer default 8 )
returns table (
  customer_name text, customer_phone text, customer_address text, latest_bill_at timestamptz )
language sql
stable
security invoker
set search_path = public
as $$
  with normalized as (
  select
  b.customer_name, b.customer_phone, b.customer_address, b.created_at,
  lower(trim(b.customer_name)) as name_key, nullif(
  regexp_replace(trim(coalesce(b.customer_phone, '')), '\D', '', 'g'), ''
  ) as phone_key
  from public.bills b
  where nullif(trim(b.customer_name), '') is not null
  and exists (
  select 1
  from regexp_split_to_table(
  lower(trim(b.customer_name)), '\s+'
  ) as word
  where word like lower(trim(search_text)) || '%' )
  ), unique_customers as (
  select distinct on (name_key, coalesce(phone_key, ''))
  customer_name, customer_phone, customer_address, created_at
  from normalized
  order by
  name_key, coalesce(phone_key, ''), created_at desc )
  select
  customer_name, customer_phone, customer_address, created_at as latest_bill_at
  from unique_customers
  order by
  created_at desc, lower(trim(customer_name)) asc
  limit greatest(
  1, least(coalesce(result_limit, 8), 8) );
$$;

grant execute on function public.search_customers(text, integer)
to authenticated;

create extension if not exists pgcrypto;

-- Creates or returns the stable public token used to share an invoice without requiring customer login.
create or replace function public.get_or_create_invoice_public_token(
  p_invoice_no text )
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
  declare
  v_token text;
  begin
    if auth.uid() is null then
      raise exception 'Authentication required.';
    end if;
  if not public.is_approved() then
    raise exception 'Not authorized.';
  end if;
  if nullif(trim(p_invoice_no), '') is null then
    raise exception 'Invoice number is required.';
  end if;
  select public_token
  into v_token
  from public.bills
  where invoice_no = trim(p_invoice_no)
  for update;
    if not found then
      raise exception 'Invoice not found.';
    end if;
  if v_token is null or length(v_token) < 32 then
    v_token := encode(gen_random_bytes(32), 'hex');
    update public.bills
    set public_token = v_token
    where invoice_no = trim(p_invoice_no);
  end if;
  return v_token;
  end;
$$;

-- Returns the limited invoice data and line items exposed to a customer through a valid public token.
create or replace function public.get_public_invoice(
  p_token text )
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
stable
as $$
  declare
  v_bill public.bills%rowtype;
  v_items jsonb;
  begin
    if nullif(trim(p_token), '') is null then
      return null;
    end if;
  select b.*
  into v_bill
  from public.bills b
  where b.public_token = trim(p_token)
  limit 1;
  if not found then
    return null;
  end if;
  select coalesce(
  jsonb_agg(
  jsonb_build_object(
  'item_name', bi.item_name, 'description', coalesce(bi.description, ''),
  'serial', coalesce(bi.serial, ''), 'qty', bi.qty, 'price', bi.price )
  ), '[]'::jsonb )
  into v_items
  from public.bill_items bi
  where bi.invoice_no = v_bill.invoice_no;
  return jsonb_build_object(
  'invoice_no', v_bill.invoice_no, 'customer_name', coalesce(v_bill.customer_name, ''),
  'customer_phone', coalesce(v_bill.customer_phone, ''),
  'customer_address', coalesce(v_bill.customer_address, ''), 'bill_date', v_bill.bill_date,
  'notes', coalesce(v_bill.notes, ''), 'include_notes', v_bill.include_notes,
  'show_watermark', v_bill.show_watermark, 'show_qr', v_bill.show_qr,
  'show_signature', v_bill.show_signature, 'total', v_bill.total, 'items', v_items );
  end;
$$;

grant execute on function public.get_public_invoice(text) to anon, authenticated;

grant execute on function public.get_or_create_invoice_public_token(text) to authenticated;

revoke all on table public.bills from anon;

revoke all on table public.bill_items from anon;

revoke all on function public.get_public_invoice(text) from public;

revoke all on function public.get_or_create_invoice_public_token(text) from public;

grant execute on function public.get_public_invoice(text) to anon, authenticated;

grant execute on function public.get_or_create_invoice_public_token(text) to authenticated;

BEGIN;

-- Soft-deletes an invoice by setting deleted_at; preserves the bill and its items for recovery during the retention period.
CREATE OR REPLACE FUNCTION public.soft_delete_bill(
  p_invoice_no TEXT )
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
  DECLARE
  affected_rows INTEGER;
  BEGIN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Authentication required.';
    END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only approved admins can delete bills.';
  END IF;
  UPDATE public.bills
  SET deleted_at = pg_catalog.now()
  WHERE invoice_no = p_invoice_no
  AND deleted_at IS NULL;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows = 0 THEN
    RAISE EXCEPTION 'Bill not found or already deleted.';
  END IF;
  RETURN TRUE;
  END;
$$;

-- Restores a previously soft-deleted invoice by clearing deleted_at.
CREATE OR REPLACE FUNCTION public.restore_bill(
  p_invoice_no TEXT )
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
  DECLARE
  affected_rows INTEGER;
  BEGIN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Authentication required.';
    END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only approved admins can restore bills.';
  END IF;
  UPDATE public.bills
  SET deleted_at = NULL
  WHERE invoice_no = p_invoice_no
  AND deleted_at IS NOT NULL;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows = 0 THEN
    RAISE EXCEPTION 'Deleted bill not found or already restored.';
  END IF;
  RETURN TRUE;
  END;
$$;

-- Allows an authorized administrator to update a user's role/approval access with server-side validation.
CREATE OR REPLACE FUNCTION public.admin_update_profile_access(
  p_user_id UUID, p_role TEXT, p_status TEXT )
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
  DECLARE
  v_updated INTEGER;
  BEGIN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'Only approved administrators can perform this action';
    END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'employee') THEN
    RAISE EXCEPTION 'Invalid role. Only admin or employee is allowed';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;
  IF p_user_id IS NULL OR p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot change your own role or status';
  END IF;
  UPDATE public.profiles
  SET
  role = p_role, status = p_status
  WHERE id = p_user_id
  AND role IN ('admin', 'employee');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'User not found or insufficient permissions';
  END IF;
  END;
$$;

ALTER FUNCTION public.admin_update_profile_access(UUID, TEXT, TEXT)
OWNER TO postgres;

REVOKE ALL ON FUNCTION
public.admin_update_profile_access(UUID, TEXT, TEXT)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
public.admin_update_profile_access(UUID, TEXT, TEXT)
TO authenticated;

REVOKE ALL ON FUNCTION public.soft_delete_bill(TEXT)
FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.restore_bill(TEXT)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.soft_delete_bill(TEXT)
TO authenticated;

GRANT EXECUTE ON FUNCTION public.restore_bill(TEXT)
TO authenticated;

COMMIT;

-- INDEXES
-- pgcrypto was enabled above before the public-token functions that use it.

-- Explicit indexes: 5 total.
-- bill_items_invoice_no_idx: speeds up loading all line items for an invoice.
create index if not exists bill_items_invoice_no_idx
on public.bill_items(invoice_no);

-- bills_customer_name_idx: speeds up customer-name lookup and autocomplete.
create index if not exists bills_customer_name_idx
on public.bills(customer_name);

-- bills_customer_phone_idx: speeds up customer-phone lookup.
create index if not exists bills_customer_phone_idx
on public.bills(customer_phone);

-- bills_created_at_idx: supports sorting/filtering invoices by creation time.
create index if not exists bills_created_at_idx
on public.bills(created_at);

-- bills_public_token_uidx: enforces unique non-null public invoice tokens and supports token lookup.
create unique index if not exists bills_public_token_uidx
on public.bills(public_token)
where public_token is not null;

-- Automatic indexes (not created separately here):
-- profiles_pkey, bills_pkey, and supabase_heartbeat_pkey are created by their PRIMARY KEY constraints.
-- No bill_items_bill_id_idx: it was an exact duplicate of bill_items_invoice_no_idx.
-- No bills_invoice_no_idx: bills.invoice_no already has the PRIMARY KEY index.

-- ============================================================
-- EDGE FUNCTIONS — 3 TOTAL (deploy separately; these are not SQL)
-- check-email-exists: validates an email and calls check_email_exists() to report existence/confirmation.
-- send-feedback: accepts app feedback and sends the message through the configured email provider.
-- supabase-heartbeat: updates heartbeat status, removes unverified Auth users older than 7 days,
-- and permanently purges soft-deleted bills older than 7 days (items are removed first).
-- The commented reference code below is documentation only; deploy each function in Supabase separately.
-- ============================================================

-- Email existence lookup
-- import { createClient } from "npm:@supabase/supabase-js@2";
-- const corsHeaders = {
--   "Access-Control-Allow-Origin": "*",
--   "Access-Control-Allow-Headers":
--     "authorization, x-client-info, apikey, content-type",
--   "Access-Control-Allow-Methods": "POST, OPTIONS",
--   "Content-Type": "application/json",
-- };
-- const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
-- if (!SUPABASE_URL) {
--   throw new Error("SUPABASE_URL is required");
-- }
-- const rawSecretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
-- if (!rawSecretKeys) {
--   throw new Error("SUPABASE_SECRET_KEYS is required");
-- }
-- const secretKeys = JSON.parse(rawSecretKeys);
-- const ADMIN_KEY = secretKeys["default"];
-- if (!ADMIN_KEY) {
--   throw new Error("Default secret key is missing");
-- }
-- const supabaseAdmin = createClient(
--   SUPABASE_URL,
--   ADMIN_KEY,
--   {
--     auth: {
--       autoRefreshToken: false,
--       persistSession: false,
--       detectSessionInUrl: false,
--     },
--   }
-- );
-- Deno.serve(async (req: Request) => {
--   if (req.method === "OPTIONS") {
--     return new Response(null, {
--       status: 204,
--       headers: corsHeaders,
--     });
--   }
--   if (req.method !== "POST") {
--     return new Response(
--       JSON.stringify({
--         error: "Method not allowed",
--       }),
--       {
--         status: 405,
--         headers: corsHeaders,
--       }
--     );
--   }
--   let body;
--   try {
--     body = await req.json();
--   } catch {
--     return new Response(
--       JSON.stringify({
--         error: "Invalid JSON",
--       }),
--       {
--         status: 400,
--         headers: corsHeaders,
--       }
--     );
--   }
--   const email = String(body?.email || "")
--     .trim()
--     .toLowerCase();
--   if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
--     return new Response(
--       JSON.stringify({
--         error: "Valid email is required",
--       }),
--       {
--         status: 400,
--         headers: corsHeaders,
--       }
--     );
--   }
--   try {
--     const { data, error } = await supabaseAdmin.rpc(
--       "check_email_exists",
--       { check_email: email }
--     );
--     if (error) {
--       console.error("check_email_exists RPC error:", error);
--       return new Response(
--         JSON.stringify({
--           error: "Could not check email",
--         }),
--         {
--           status: 500,
--           headers: corsHeaders,
--         }
--       );
--     }
--     const row = Array.isArray(data) ? data[0] : data;
--     const exists = !!row;
--     const emailConfirmed = exists ? Boolean(row.confirmed) : false;
--     return new Response(
--       JSON.stringify({
--         exists,
--         email_confirmed: emailConfirmed,
--         confirmed: emailConfirmed,
--       }),
--       {
--         status: 200,
--         headers: corsHeaders,
--       }
--     );
--   } catch (error) {
--     console.error("check-email-exists error:", error);
--     return new Response(
--       JSON.stringify({
--         error: "Could not check email",
--       }),
--       {
--         status: 500,
--         headers: corsHeaders,
--       }
--     );
--   }
-- });

-- ------------------------------------------------------------
-- 2. SEND APP FEEDBACK EMAIL
-- ------------------------------------------------------------

-- import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
-- const corsHeaders = {
--   "Access-Control-Allow-Origin": "*",
--   "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
--   "Access-Control-Allow-Methods": "POST, OPTIONS",
-- };
-- const json = (body: unknown, status = 200) =>
--   new Response(JSON.stringify(body), {
--     status,
--     headers: { ...corsHeaders, "Content-Type": "application/json" },
--   });
-- const esc = (v: string) =>
--   v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
-- Deno.serve(async (req) => {
--   if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
--   if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
--   try {
--     const supabase = createClient(
--       Deno.env.get("SUPABASE_URL")!,
--       Deno.env.get("SUPABASE_ANON_KEY")!,
--       { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
--     );
--     const { data: { user }, error: authError } = await supabase.auth.getUser();
--     if (authError || !user) return json({ error: "Unauthorized" }, 401);
--     const body = await req.json();
--     const feedback = String(body.feedback ?? "").trim();
--     if (feedback.length < 10 || feedback.length > 1000) {
--       return json({ error: "Invalid feedback length" }, 400);
--     }
--     const { data: profile } = await supabase
--       .from("profiles")
--       .select("name")
--       .eq("id", user.id)
--       .maybeSingle();
--     const name =
--       String(profile?.name ?? user.user_metadata?.full_name ?? user.user_metadata?.name ?? "")
--         .trim()
--         .slice(0, 100) || "Unknown";
--     const email = user.email ?? "Unknown";
--     const appVersion = String(body.app_version ?? "unknown").trim().slice(0, 40);
--     const tz = String(body.timezone ?? "UTC").slice(0, 60);
--     const sentAt = new Date();
--     let when: string;
--     try {
--       when = sentAt.toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }) + ` (${tz})`;
--     } catch {
--       when = sentAt.toISOString();
--     }
--     const resendApiKey = Deno.env.get("RESEND_API_KEY");
--     const toEmail = Deno.env.get("FEEDBACK_TO_EMAIL");
--     const fromEmail = Deno.env.get("FEEDBACK_FROM_EMAIL");
--     if (!resendApiKey || !toEmail || !fromEmail) {
--       console.error("Feedback email secrets are not configured.");
--       return json({ error: "Feedback service is not configured" }, 500);
--     }
--     const html = `
--       <h2>New app feedback</h2>
--       <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
--         <tr><td><b>Name</b></td><td>${esc(name)}</td></tr>
--         <tr><td><b>Email</b></td><td>${esc(email)}</td></tr>
--         <tr><td><b>App version</b></td><td>${esc(appVersion)}</td></tr>
--         <tr><td><b>Date / time</b></td><td>${esc(when)}</td></tr>
--       </table>
--       <h3>Feedback</h3>
--       <p style="white-space:pre-wrap;font-family:Arial,sans-serif;font-size:14px">${esc(feedback)}</p>`;
--     const res = await fetch("https://api.resend.com/emails", {
--       method: "POST",
--       headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
--       body: JSON.stringify({
--         from: fromEmail,
--         to: [toEmail],
--         reply_to: email !== "Unknown" ? email : undefined,
--         subject: `App feedback from ${name} (${appVersion})`,
--         html,
--       }),
--     });
--     if (!res.ok) {
--       console.error("Resend error:", res.status, await res.text());
--       return json({ error: "Email provider rejected the request" }, 502);
--     }
--     return json({ ok: true });
--   } catch (error) {
--     console.error("send-feedback error:", error);
--     return json({ error: "Server error" }, 500);
--   }
-- });

-- Heartbeat, unverified-user and expired-bill, notificaton push cleanup

-- import { createClient } from "npm:@supabase/supabase-js@2";
-- import webpush from "npm:web-push@3.6.7";

-- const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
-- if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");

-- const rawPublishableKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
-- if (!rawPublishableKeys) throw new Error("SUPABASE_PUBLISHABLE_KEYS is required");
-- const PUBLISHABLE_KEY = JSON.parse(rawPublishableKeys)["default"];
-- if (!PUBLISHABLE_KEY) throw new Error("Default publishable key is missing");

-- const rawSecretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
-- if (!rawSecretKeys) throw new Error("SUPABASE_SECRET_KEYS is required");
-- const ADMIN_KEY = JSON.parse(rawSecretKeys)["default"];
-- if (!ADMIN_KEY) throw new Error("Default secret key is missing");

-- const supabaseAdmin = createClient(SUPABASE_URL, ADMIN_KEY, {
--   auth: {
--     autoRefreshToken: false,
--     persistSession: false,
--     detectSessionInUrl: false,
--   },
-- });

-- // ---------------- Web Push (VAPID) ----------------
-- const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
-- const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
-- const VAPID_SUBJECT =
--   Deno.env.get("VAPID_SUBJECT") ?? "mailto:jastechhyd@gmail.com";
-- const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

-- if (PUSH_ENABLED) {
--   webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
-- }

-- // ---------------- Settings ----------------
-- const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
-- const USER_RETENTION_MS = SEVEN_DAYS_MS;
-- const BILL_RETENTION_MS = SEVEN_DAYS_MS;
-- const OVERDUE_PAUSE_DAYS = 7; // keep in sync with index.html
-- const BILL_PURGE_BATCH = 200;
-- const PUSH_TTL_SECONDS = 12 * 60 * 60;
-- const REMINDER_BATCH = 1000;
-- const PUSH_CONCURRENCY = 10;

-- type Status = "success" | "partial" | "failed";

-- // ---------------- Reminders: auto-pause + push ----------------
-- type ReminderPushResult = {
--   status: Status;
--   today: string | null;
--   pausedCount: number;
--   dueCount: number;
--   sentCount: number;
--   noDeviceCount: number;
--   failedCount: number; // REAL failures only (never 404/410)
--   clearedDevices: number; // dead devices (user turned off / reset notifications)
--   error: string | null;
-- };

-- function shiftIsoDate(iso: string, days: number): string {
--   return new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);
-- }

-- async function sendDueReminderPushes(): Promise<ReminderPushResult> {
--   const result: ReminderPushResult = {
--     status: "success",
--     today: null,
--     pausedCount: 0,
--     dueCount: 0,
--     sentCount: 0,
--     noDeviceCount: 0,
--     failedCount: 0,
--     clearedDevices: 0,
--     error: null,
--   };

--   try {
--     const { data: today, error: todayError } = await supabaseAdmin.rpc(
--       "app_today"
--     );

--     if (todayError || !today) {
--       return {
--         ...result,
--         status: "failed",
--         error: `app_today failed: ${todayError?.message ?? "no value"}`,
--       };
--     }

--     const todayIso = String(today);
--     result.today = todayIso;
--     const pauseBefore = shiftIsoDate(todayIso, -OVERDUE_PAUSE_DAYS);

--     // 1. auto-pause
--     const { data: paused, error: pauseError } = await supabaseAdmin
--       .from("reminders")
--       .update({ status: "paused" })
--       .eq("status", "active")
--       .lt("remember_date", pauseBefore)
--       .select("id");

--     if (pauseError) {
--       console.error("Auto-pause failed:", pauseError);
--       result.status = "partial";
--       result.error = `Auto-pause failed: ${pauseError.message}`;
--     } else {
--       result.pausedCount = paused?.length ?? 0;
--     }

--     // 2. push
--     const { data: rows, error: remindersError } = await supabaseAdmin
--       .from("reminders")
--       .select("id,user_id,title,description,remember_date,last_activity")
--       .eq("status", "active")
--       .gte("remember_date", pauseBefore)
--       .lte("remember_date", todayIso)
--       .order("remember_date", { ascending: true })
--       .limit(REMINDER_BATCH);

--     if (remindersError) {
--       return {
--         ...result,
--         status: "failed",
--         error: `Reminder lookup failed: ${remindersError.message}`,
--       };
--     }

--     const due = (rows ?? []).filter(
--       (r) => !r.last_activity || r.last_activity < r.remember_date
--     );
--     result.dueCount = due.length;

--     if (!due.length) return result;

--     if (!PUSH_ENABLED) {
--       return {
--         ...result,
--         status: "failed",
--         error: "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not configured",
--       };
--     }

--     const userIds = [...new Set(due.map((r) => r.user_id as string))];

--     const { data: profiles, error: profilesError } = await supabaseAdmin
--       .from("profiles")
--       .select("id,push_id")
--       .in("id", userIds)
--       .not("push_id", "is", null);

--     if (profilesError) {
--       return {
--         ...result,
--         status: "failed",
--         error: `Device lookup failed: ${profilesError.message}`,
--       };
--     }

--     const subscriptions = new Map<string, unknown>(
--       (profiles ?? []).map((p) => [p.id as string, p.push_id])
--     );

--     const deadUsers = new Set<string>();
--     const failureMessages: string[] = [];

--     const sendOne = async (r: (typeof due)[number]) => {
--       const subscription = subscriptions.get(r.user_id);

--       if (!subscription) {
--         result.noDeviceCount++;
--         return;
--       }

--       // A device already found dead earlier in this run: skip, don't push again
--       if (deadUsers.has(r.user_id)) return;

--       const overdueDays = Math.round(
--         (Date.parse(todayIso) - Date.parse(r.remember_date)) / 86400000
--       );

--       const base =
--         r.description ||
--         (overdueDays > 0
--           ? `Overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"}`
--           : "Due today");

--       const payload = JSON.stringify({
--         title: r.title,
--         body:
--           overdueDays >= OVERDUE_PAUSE_DAYS
--             ? `${base} · Last reminder. It will be paused tomorrow.`
--             : base,
--         tag: `reminder-${r.id}`,
--         url: "./index.html?mode=reminders",
--       });

--       try {
--         await webpush.sendNotification(
--           subscription as webpush.PushSubscription,
--           payload,
--           { TTL: PUSH_TTL_SECONDS, urgency: "high" }
--         );
--         result.sentCount++;
--       } catch (error) {
--         const code = (error as { statusCode?: number }).statusCode;

--         if (code === 404 || code === 410) {
--           // Normal: user turned off / reset notifications, or browser removed
--           // the subscription. NOT a failure. Device is cleared below.
--           deadUsers.add(r.user_id);
--           console.log(`Dead subscription (${code}) for user ${r.user_id}`);
--         } else {
--           // Real failure: push service down, bad VAPID keys, network, etc.
--           result.failedCount++;
--           failureMessages.push(`${code ?? "error"}`);
--           console.error("Push failed:", code, error);
--         }
--       }
--     };

--     for (let i = 0; i < due.length; i += PUSH_CONCURRENCY) {
--       await Promise.all(due.slice(i, i + PUSH_CONCURRENCY).map(sendOne));
--     }

--     // Clear dead devices so the Reminders tab shows "No device activated"
--     if (deadUsers.size) {
--       const { error: clearError } = await supabaseAdmin
--         .from("profiles")
--         .update({ push_id: null, device_data: null })
--         .in("id", [...deadUsers]);

--       if (clearError) {
--         console.error("Could not clear dead devices:", clearError);
--         result.status = "partial";
--         result.error = `Clear devices failed: ${clearError.message}`;
--       } else {
--         result.clearedDevices = deadUsers.size;
--       }
--     }

--     // Only REAL push failures affect status
--     if (result.failedCount > 0) {
--       result.status = result.sentCount > 0 ? "partial" : "failed";
--       result.error = `${result.failedCount} push(es) failed (${[
--         ...new Set(failureMessages),
--       ].join(", ")})`;
--     }

--     return result;
--   } catch (error) {
--     console.error("Reminder push error:", error);
--     return {
--       ...result,
--       status: "failed",
--       error: error instanceof Error ? error.message : String(error),
--     };
--   }
-- }

-- // ---------------- Edge Function ----------------
-- Deno.serve(async (req: Request) => {
--   if (req.method !== "POST") {
--     return Response.json({ error: "Method not allowed" }, { status: 405 });
--   }

--   if (req.headers.get("apikey") !== PUBLISHABLE_KEY) {
--     return Response.json({ error: "Unauthorized" }, { status: 401 });
--   }

--   try {

--     // 2. DELETE UNVERIFIED USERS OLDER THAN 7 DAYS
--     const cutoff = new Date(Date.now() - USER_RETENTION_MS);
--     const deleted: string[] = [];
--     const failed: { id: string; email: string | null; error: string }[] = [];
--     let checkedCount = 0;
--     let unverifiedCount = 0;
--     let usersError: string | null = null;

--     try {
--       let page = 1;
--       const perPage = 1000;
--       const usersToDelete: { id: string; email: string | null }[] = [];

--       while (true) {
--         const { data, error } = await supabaseAdmin.auth.admin.listUsers({
--           page,
--           perPage,
--         });
--         if (error) throw error;

--         const users = data.users;
--         if (!users.length) break;

--         checkedCount += users.length;

--         for (const user of users) {
--           const isUnverified = !user.email_confirmed_at;
--           if (isUnverified) unverifiedCount++;
--           if (isUnverified && new Date(user.created_at) < cutoff) {
--             usersToDelete.push({ id: user.id, email: user.email ?? null });
--           }
--         }

--         if (users.length < perPage) break;
--         page++;
--       }

--       for (const u of usersToDelete) {
--         const { error: deleteError } =
--           await supabaseAdmin.auth.admin.deleteUser(u.id);
--         if (deleteError) {
--           failed.push({ id: u.id, email: u.email, error: deleteError.message });
--         } else {
--           deleted.push(u.email ?? u.id);
--         }
--       }
--     } catch (error) {
--       usersError = error instanceof Error ? error.message : String(error);
--       console.error("User cleanup error:", error);
--     }

--     if (!usersError && failed.length > 0) {
--       usersError = `${failed.length} user(s) could not be deleted`;
--     }

--     const usersStatus: Status = usersError
--       ? deleted.length > 0 || checkedCount > 0 && failed.length > 0
--         ? "partial"
--         : "failed"
--       : "success";

--     // 3. PURGE SOFT-DELETED BILLS OLDER THAN 7 DAYS
--     const billCutoff = new Date(Date.now() - BILL_RETENTION_MS);
--     const purgedBills: string[] = [];
--     let billsError: string | null = null;

--     while (true) {
--       const { data: expired, error: expiredError } = await supabaseAdmin
--         .from("bills")
--         .select("invoice_no")
--         .not("deleted_at", "is", null)
--         .lt("deleted_at", billCutoff.toISOString())
--         .limit(BILL_PURGE_BATCH);

--       if (expiredError) {
--         billsError = `Lookup failed: ${expiredError.message}`;
--         console.error("Bill purge lookup error:", expiredError);
--         break;
--       }
--       if (!expired || !expired.length) break;

--       const invoiceNos = expired.map((b) => b.invoice_no);

--       const { error: itemsError } = await supabaseAdmin
--         .from("bill_items")
--         .delete()
--         .in("invoice_no", invoiceNos);

--       if (itemsError) {
--         billsError = `Items delete failed: ${itemsError.message}`;
--         console.error("Bill items purge error:", itemsError);
--         break;
--       }

--       const { error: billsDeleteError } = await supabaseAdmin
--         .from("bills")
--         .delete()
--         .in("invoice_no", invoiceNos)
--         .not("deleted_at", "is", null);

--       if (billsDeleteError) {
--         billsError = `Bills delete failed: ${billsDeleteError.message}`;
--         console.error("Bill purge error:", billsDeleteError);
--         break;
--       }

--       purgedBills.push(...invoiceNos);
--       if (expired.length < BILL_PURGE_BATCH) break;
--     }

--     const billsStatus: Status = billsError
--       ? purgedBills.length > 0
--         ? "partial"
--         : "failed"
--       : "success";

--     // 4. REMINDERS
--     const reminders = await sendDueReminderPushes();

--     // 1. HEARTBEAT
--     const indianTime = new Date().toLocaleString("en-IN", {
--       timeZone: "Asia/Kolkata",
--       day: "2-digit",
--       month: "short",
--       year: "numeric",
--       hour: "2-digit",
--       minute: "2-digit",
--       second: "2-digit",
--       hour12: true,
--     });

--     // 5. SAVE SIMPLE STATUS
--     const { error: statusError } = await supabaseAdmin
--       .from("supabase_heartbeat")
--       .update({
--         last_ping: indianTime,
--         users_status: usersStatus,
--         users_purged: deleted.length,
--         users_error: usersError,
--         bills_status: billsStatus,
--         bills_purged: purgedBills.length,
--         bills_error: billsError,
--         reminders_status: reminders.status,
--         reminders_sent: reminders.sentCount,
--         reminders_failed: reminders.failedCount,
--         reminders_cleared: reminders.clearedDevices,
--         reminders_error: reminders.error,
--       })
--       .eq("id", 1);

--     if (statusError) {
--       console.error("Heartbeat status update error:", statusError);
--     }

--     // 6. LOG
--     console.log(
--       JSON.stringify({
--         heartbeat: indianTime,
--         usersStatus,
--         checkedCount,
--         unverifiedCount,
--         deletedCount: deleted.length,
--         failedCount: failed.length,
--         usersError,
--         billsStatus,
--         purgedBillsCount: purgedBills.length,
--         billsError,
--         reminders,
--         statusSaved: !statusError,
--       })
--     );

--     // 7. RESULT
--     // 500 (GitHub run fails) ONLY when a section is truly "failed".
--     // "partial" and dead devices (410) return 200.
--     const hasFailure =
--       usersStatus === "failed" ||
--       billsStatus === "failed" ||
--       reminders.status === "failed";

--     return Response.json(
--       {
--         success: !hasFailure,
--         heartbeat: indianTime,
--         users: {
--           status: usersStatus,
--           checked: checkedCount,
--           unverified: unverifiedCount,
--           deleted: deleted.length,
--           failed: failed.length,
--           error: usersError,
--         },
--         bills: {
--           status: billsStatus,
--           purged: purgedBills.length,
--           error: billsError,
--         },
--         reminders,
--         statusSaved: !statusError,
--       },
--       { status: hasFailure ? 500 : 200 }
--     );
--   } catch (error) {
--     console.error("Combined heartbeat/cleanup error:", error);
--     return Response.json(
--       {
--         success: false,
--         error: error instanceof Error ? error.message : String(error),
--       },
--       { status: 500 }
--     );
--   }
-- });
-- ============================================================
-- GITHUB ACTIONS WORKFLOW
-- GitHub Actions workflow: invokes supabase-heartbeat every 12 hours and supports manual workflow_dispatch.
-- Also supports manual execution through workflow_dispatch.
-- Save this block separately as .github/workflows/supabase-heartbeat.yml.
-- ============================================================

-- name: Supabase Heartbeat
--
-- on:
--   schedule:
--     - cron: "0 */12 * * *"
--   workflow_dispatch:
--
-- jobs:
--   heartbeat:
--     runs-on: ubuntu-latest
--
--     steps:
--       - name: Update Supabase heartbeat
--         run: |
--           curl --fail --silent --show-error \
--             --request POST \
--             --url "https://tdytfzqtaxijlbmfnxee.supabase.co/functions/v1/supabase-heartbeat" \
--             --header "apikey: ${{ secrets.SUPABASE_PUBLISHABLE_KEY }}" \
--             --header "Content-Type: application/json"
