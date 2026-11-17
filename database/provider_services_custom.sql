-- ==============================================================================
-- Tender Touch: custom ("Other") services and booking only listed services
-- Additive and idempotent. Existing bookings and payments are not changed.
--
--  * Providers may list any service name (2–60 characters), not just the
--    nine standard ones.
--  * A new booking must use a service the chosen provider actively lists;
--    the standard price list is no longer used for new bookings.
--  * Older bookings without a price still use the standard price when paid.
-- Requires database/provider_pricing.sql.
-- ==============================================================================

-- 1. Allow custom service names.
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.provider_services'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%service_type%'
  loop
    execute format('alter table public.provider_services drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.provider_services
  add constraint provider_services_service_name_check
  check (service_type = btrim(service_type) and char_length(service_type) between 2 and 60);

-- 2. Shared price calculation; p_allow_standard only for bookings made before
--    providers had price lists.
create or replace function public.quote_service_price(p_provider uuid, p_service text, p_allow_standard boolean)
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
  base := coalesce(listed, case when p_allow_standard then public.standard_price_paise(p_service) end);
  if base is null then
    raise exception 'This provider does not offer "%". Choose one of their listed services.', p_service
      using errcode = '22023';
  end if;
  select value into pct from public.platform_settings where key = 'commission_percent';
  pct := coalesce(pct, 10);
  commission := round(base * pct / 100.0);
  return jsonb_build_object('provider_paise', base, 'commission_paise', commission,
                            'total_paise', base + commission, 'commission_percent', pct,
                            'listed', listed is not null);
end;
$$;
revoke all on function public.quote_service_price(uuid, text, boolean) from public, anon, authenticated;

-- Quotes for new bookings: listed services only.
create or replace function public.quote_booking(p_provider uuid, p_service text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.quote_service_price(p_provider, p_service, false);
$$;
revoke all on function public.quote_booking(uuid, text) from public, anon;
grant execute on function public.quote_booking(uuid, text) to authenticated;

-- Paying for an older booking that has no stored price still works.
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
    q := public.quote_service_price(b.provider_id, b.service_type, true);
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
