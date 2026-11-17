-- ==============================================================================
-- Tender Touch: provider logic fixes (November 2026)
-- Additive and idempotent. Does not delete rows; recalculates completed_jobs.
-- ==============================================================================

-- 1. No GPS check-in before the day of the visit (Kerala date).
--    Covers the provider's own check-in (visit_reports) and the worker's secret
--    link (worker_checkins, written by worker_check_in()).
create or replace function public.reject_early_checkin()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  visit_date date;
  checkin_at timestamptz;
begin
  if tg_table_name = 'visit_reports' then
    checkin_at := new.checked_in_at;
    if checkin_at is null or (tg_op = 'UPDATE' and checkin_at is not distinct from old.checked_in_at) then
      return new;
    end if;
  else
    checkin_at := new.check_in_time;
    if checkin_at is null or (tg_op = 'UPDATE' and checkin_at is not distinct from old.check_in_time) then
      return new;
    end if;
  end if;

  select b.scheduled_date into visit_date from public.bookings b where b.id = new.booking_id;
  if visit_date is not null and visit_date > (pg_catalog.now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Check-in opens on %, the day of the visit.', to_char(visit_date, 'DD Mon YYYY')
      using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_early_checkin() from public, anon, authenticated;

drop trigger if exists visit_reports_reject_early_checkin on public.visit_reports;
create trigger visit_reports_reject_early_checkin
  before insert or update on public.visit_reports
  for each row execute function public.reject_early_checkin();

drop trigger if exists worker_checkins_reject_early_checkin on public.worker_checkins;
create trigger worker_checkins_reject_early_checkin
  before insert or update on public.worker_checkins
  for each row execute function public.reject_early_checkin();

-- 2. Keep profiles.completed_jobs equal to the provider's completed bookings.
--    It was never updated, so every provider showed 0 jobs.
create or replace function public.sync_provider_completed_jobs()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected uuid;
begin
  foreach affected in array array_remove(array[new.provider_id, case when tg_op = 'UPDATE' then old.provider_id end], null) loop
    update public.profiles p
       set completed_jobs = (select count(*) from public.bookings b
                             where b.provider_id = affected and b.status = 'completed')
     where p.id = affected;
  end loop;
  return null;
end;
$$;
revoke all on function public.sync_provider_completed_jobs() from public, anon, authenticated;

drop trigger if exists bookings_sync_completed_jobs on public.bookings;
create trigger bookings_sync_completed_jobs
  after insert or update of status, provider_id on public.bookings
  for each row execute function public.sync_provider_completed_jobs();

-- One-time recount for existing providers.
update public.profiles p
   set completed_jobs = (select count(*) from public.bookings b
                         where b.provider_id = p.id and b.status = 'completed')
 where p.role = 'provider';
