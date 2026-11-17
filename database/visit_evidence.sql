-- ==============================================================================
-- Tender Touch: a job can be completed (and paid out) only with real visit evidence
-- Additive and idempotent. Does not change existing rows.
--
-- Before this, a provider could mark an assigned job "completed" with no visit,
-- from 5 km away, after a one-minute stop, with browser-faked times or with no
-- photo, and the owner's payment was released automatically.
-- ==============================================================================

-- 1. Check-in / check-out times are set by the server and cannot be rewritten.
--    (Named "aa_..." so it runs before the other visit_reports triggers.)
create or replace function public.visit_report_server_times()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;

  if tg_op = 'UPDATE' and old.checked_in_at is not null then
    -- The first check-in is evidence: keep its time and location.
    new.checked_in_at := old.checked_in_at;
    new.check_in_lat := old.check_in_lat;
    new.check_in_lng := old.check_in_lng;
    new.check_in_photo_url := coalesce(old.check_in_photo_url, new.check_in_photo_url);
  elsif new.checked_in_at is not null then
    new.checked_in_at := now();
  end if;

  if tg_op = 'UPDATE' and old.checked_out_at is not null then
    new.checked_out_at := old.checked_out_at;
  elsif new.checked_out_at is not null then
    if new.checked_in_at is null then
      raise exception 'Check in at the property before checking out.' using errcode = '22023';
    end if;
    new.checked_out_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.visit_report_server_times() from public, anon, authenticated;

drop trigger if exists aa_visit_report_server_times on public.visit_reports;
create trigger aa_visit_report_server_times
  before insert or update on public.visit_reports
  for each row execute function public.visit_report_server_times();

-- 2. Completing a job requires evidence of the visit.
create or replace function public.require_visit_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, storage
as $$
declare
  vr public.visit_reports%rowtype;
  minutes numeric;
  photo_path text;
  min_minutes constant integer := 15;
begin
  if new.status is distinct from 'completed' or old.status = 'completed' then return new; end if;
  if auth.uid() is null or public.is_admin() then return new; end if;

  select * into vr from public.visit_reports
   where booking_id = new.id and provider_id = new.provider_id
   order by created_at desc limit 1;

  if vr.id is null or vr.checked_in_at is null then
    raise exception 'Check in at the property with GPS before completing this visit.' using errcode = '22023';
  end if;
  if vr.checked_out_at is null then
    raise exception 'Check out of the property before completing this visit.' using errcode = '22023';
  end if;
  if vr.inside_geofence is not true and not exists (
    select 1 from public.worker_checkins c where c.booking_id = new.id and c.inside_geofence
  ) then
    raise exception 'This visit was not recorded on site (inside the property''s geo-fence), so it cannot be completed. Contact the property owner if you were there.'
      using errcode = '22023';
  end if;

  minutes := extract(epoch from (vr.checked_out_at - vr.checked_in_at)) / 60;
  if minutes < min_minutes then
    raise exception 'A visit must last at least % minutes on site; this one lasted % minutes.', min_minutes, floor(minutes)
      using errcode = '22023';
  end if;

  -- The after photo must be a file this provider uploaded to the visit-photos bucket.
  photo_path := split_part(split_part(coalesce(vr.after_photo_url, ''), '/visit-photos/', 2), '?', 1);
  if photo_path = '' or not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'visit-photos' and o.name = photo_path
       and (storage.foldername(o.name))[1] = new.provider_id::text
  ) then
    raise exception 'Add an after photo taken during the visit before completing it.' using errcode = '22023';
  end if;

  return new;
end;
$$;
revoke all on function public.require_visit_evidence() from public, anon, authenticated;

drop trigger if exists bookings_require_visit_evidence on public.bookings;
create trigger bookings_require_visit_evidence
  before update of status on public.bookings
  for each row execute function public.require_visit_evidence();
