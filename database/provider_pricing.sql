-- ==============================================================================
-- Tender Touch: provider price lists, platform commission and held payments
-- Additive and idempotent. Existing bookings and payments are not changed.
--
--  * Providers list the services they offer with their own price.
--  * The owner pays that price + the platform commission (platform_settings).
--    Prices are calculated here, never trusted from the browser.
--  * The owner's money is held ("paid") until the job is completed with visit
--    evidence; then it is released: the provider receives provider_amount and
--    the platform keeps commission_amount. Cancelled bookings are refunded.
--  * Nobody can mark a payment released by hand or change its amounts.
-- ==============================================================================

-- 1. Platform settings (commission rate) ---------------------------------------
create table if not exists public.platform_settings (
  key        text primary key,
  value      numeric not null,
  updated_at timestamptz not null default now()
);
alter table public.platform_settings enable row level security;
drop policy if exists "platform_settings_read" on public.platform_settings;
create policy "platform_settings_read" on public.platform_settings
  for select to authenticated using (true);
drop policy if exists "platform_settings_admin" on public.platform_settings;
create policy "platform_settings_admin" on public.platform_settings
  for all using (public.is_admin()) with check (public.is_admin());
insert into public.platform_settings (key, value) values ('commission_percent', 10)
on conflict (key) do nothing;

-- 2. Provider price lists ------------------------------------------------------
create table if not exists public.provider_services (
  id           uuid primary key default gen_random_uuid(),
  provider_id  uuid not null references public.profiles(id) on delete cascade,
  service_type text not null check (service_type in (
                 'General Cleaning', 'Deep Cleaning', 'Plumbing Check', 'Electrical Check',
                 'Garden Maintenance', 'Pest Control', 'Monsoon Prep', 'Security Check', 'Full Inspection')),
  price_paise  integer not null check (price_paise between 10000 and 10000000), -- ₹100 to ₹1,00,000
  description  text check (description is null or char_length(description) <= 200),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider_id, service_type)
);
alter table public.provider_services enable row level security;
drop policy if exists "provider_services_read" on public.provider_services;
create policy "provider_services_read" on public.provider_services
  for select to authenticated using (true);
drop policy if exists "provider_services_own" on public.provider_services;
create policy "provider_services_own" on public.provider_services
  for all
  using (auth.uid() = provider_id
         and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider'))
  with check (auth.uid() = provider_id
         and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider'));

-- 3. Price calculation ---------------------------------------------------------
create or replace function public.standard_price_paise(p_service text)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_service
    when 'General Cleaning' then 150000 when 'Deep Cleaning' then 350000
    when 'Plumbing Check' then 120000   when 'Electrical Check' then 120000
    when 'Garden Maintenance' then 200000 when 'Pest Control' then 250000
    when 'Monsoon Prep' then 300000     when 'Security Check' then 100000
    when 'Full Inspection' then 500000  else null end;
$$;

-- Price a booking: the provider's listed price (or the standard price) + commission.
create or replace function public.quote_booking(p_provider uuid, p_service text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  listed integer;
  base integer;
  pct numeric;
  commission integer;
begin
  select s.price_paise into listed from public.provider_services s
   where s.provider_id = p_provider and s.service_type = p_service and s.is_active;
  base := coalesce(listed, public.standard_price_paise(p_service));
  if base is null then
    raise exception 'Unknown service: %', p_service using errcode = '22023';
  end if;
  select value into pct from public.platform_settings where key = 'commission_percent';
  pct := coalesce(pct, 10);
  commission := round(base * pct / 100.0);
  return jsonb_build_object('provider_paise', base, 'commission_paise', commission,
                            'total_paise', base + commission, 'commission_percent', pct,
                            'listed', listed is not null);
end;
$$;
revoke all on function public.quote_booking(uuid, text) from public, anon;
grant execute on function public.quote_booking(uuid, text) to authenticated;

-- 4. Amounts on bookings and payments ------------------------------------------
alter table public.bookings add column if not exists provider_amount integer;
alter table public.bookings add column if not exists commission_amount integer;
alter table public.payments add column if not exists provider_amount integer;
alter table public.payments add column if not exists commission_amount integer;

-- New bookings are priced by the server.
create or replace function public.price_new_booking()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  q jsonb;
begin
  if new.provider_id is null then return new; end if;
  q := public.quote_booking(new.provider_id, new.service_type);
  new.amount := (q->>'total_paise')::integer;
  new.provider_amount := (q->>'provider_paise')::integer;
  new.commission_amount := (q->>'commission_paise')::integer;
  return new;
end;
$$;
revoke all on function public.price_new_booking() from public, anon, authenticated;
drop trigger if exists bookings_price_new_booking on public.bookings;
create trigger bookings_price_new_booking
  before insert on public.bookings
  for each row execute function public.price_new_booking();

-- A payment always charges exactly the booking's price.
create or replace function public.price_new_payment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  b public.bookings%rowtype;
  q jsonb;
begin
  select * into b from public.bookings where id = new.booking_id;
  if b.id is null then return new; end if;
  if b.amount is null and b.provider_id is not null then
    -- Older bookings were created before server-side pricing.
    q := public.quote_booking(b.provider_id, b.service_type);
    b.amount := (q->>'total_paise')::integer;
    b.provider_amount := (q->>'provider_paise')::integer;
    b.commission_amount := (q->>'commission_paise')::integer;
  end if;
  new.amount := coalesce(b.amount, new.amount);
  new.provider_amount := coalesce(b.provider_amount, new.amount);
  new.commission_amount := coalesce(b.commission_amount, 0);
  new.provider_id := b.provider_id;
  new.owner_id := b.owner_id;
  if auth.uid() is not null and not public.is_admin() and new.status not in ('unpaid', 'paid') then
    raise exception 'A new payment can only be unpaid or paid.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.price_new_payment() from public, anon, authenticated;
drop trigger if exists payments_price_new_payment on public.payments;
create trigger payments_price_new_payment
  before insert on public.payments
  for each row execute function public.price_new_payment();

-- 5. Held money: only the system releases it -----------------------------------
create or replace function public.guard_payment_updates()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  booking_status text;
begin
  -- System actions (auto-release on verified completion runs inside a trigger), SQL editor, admins.
  if pg_trigger_depth() > 1 or auth.uid() is null or public.is_admin() then return new; end if;

  -- Amounts and parties never change after the payment is created.
  new.amount := old.amount;
  new.provider_amount := old.provider_amount;
  new.commission_amount := old.commission_amount;
  new.provider_id := old.provider_id;
  new.owner_id := old.owner_id;
  new.booking_id := old.booking_id;

  if new.status is distinct from old.status then
    select status into booking_status from public.bookings where id = old.booking_id;
    if new.status = 'paid' and old.status = 'unpaid' then
      null;
    elsif new.status = 'refunded' and old.status = 'paid' and booking_status = 'cancelled' then
      null;
    elsif new.status = 'released' then
      raise exception 'Payments are released to the provider automatically when the visit is completed.' using errcode = '42501';
    else
      raise exception 'This payment change is not allowed (% → %).', old.status, new.status using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_payment_updates() from public, anon, authenticated;
drop trigger if exists payments_guard_updates on public.payments;
create trigger payments_guard_updates
  before update on public.payments
  for each row execute function public.guard_payment_updates();

-- Payment records are financial history: only admins may delete them.
create or replace function public.guard_payment_deletes()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if pg_trigger_depth() > 1 or auth.uid() is null or public.is_admin() then return old; end if;
  raise exception 'Payment records cannot be deleted.' using errcode = '42501';
end;
$$;
revoke all on function public.guard_payment_deletes() from public, anon, authenticated;
drop trigger if exists payments_guard_deletes on public.payments;
create trigger payments_guard_deletes
  before delete on public.payments
  for each row execute function public.guard_payment_deletes();
