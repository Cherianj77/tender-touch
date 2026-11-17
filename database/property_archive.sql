-- ==============================================================================
-- Tender Touch: archived (removed) properties keep their history
-- Additive and idempotent. An owner "removes" a property with bookings by setting
-- properties.is_active = false; its bookings, reports and payments are kept.
-- This rule stops new bookings from being created for an archived property.
-- ==============================================================================

create or replace function public.reject_booking_for_archived_property()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1 from public.properties p
    where p.id = new.property_id and p.is_active is false
  ) then
    raise exception 'This property has been removed. Restore it before booking a visit.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_booking_for_archived_property() from public, anon, authenticated;

drop trigger if exists bookings_reject_archived_property on public.bookings;
create trigger bookings_reject_archived_property
  before insert on public.bookings
  for each row execute function public.reject_booking_for_archived_property();
