-- Run this migration in the Supabase SQL Editor.
-- Historical bookings keep a null time because their exact visit time is unknown.
alter table public.bookings
  add column if not exists scheduled_time time;

create or replace function public.reject_past_booking_date()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  kerala_now timestamp := pg_catalog.now() at time zone 'Asia/Kolkata';
begin
  if new.scheduled_date < kerala_now::date
     or new.scheduled_time is null
     or new.scheduled_time < time '08:00'
     or new.scheduled_time > time '17:30'
     or extract(minute from new.scheduled_time)::integer % 30 <> 0
     or extract(second from new.scheduled_time) <> 0 then
    raise exception 'Choose a date from today and a time between 08:00 and 17:30 Kerala time.'
      using errcode = '22007';
  end if;

  if new.scheduled_date = kerala_now::date
     and (new.scheduled_date + new.scheduled_time) < (kerala_now + interval '1 hour') then
    raise exception 'Same-day bookings require at least one hour notice.'
      using errcode = '22007';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_past_booking_date() from public, anon, authenticated;

drop trigger if exists bookings_reject_past_date on public.bookings;
create trigger bookings_reject_past_date
  before insert or update of scheduled_date, scheduled_time on public.bookings
  for each row execute function public.reject_past_booking_date();

-- Include the appointment time on the worker's secure job details page.
create or replace function public.get_worker_checkin(p_token uuid, p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payload jsonb;
begin
  select jsonb_build_object(
    'worker', jsonb_build_object('first_name', pw.first_name, 'last_name', pw.last_name),
    'booking', jsonb_build_object('id', b.id, 'service_type', b.service_type,
                                  'scheduled_date', b.scheduled_date, 'scheduled_time', b.scheduled_time,
                                  'status', b.status),
    'property', jsonb_build_object('name', p.name, 'city', p.city, 'state', p.state,
                                   'lat', p.lat, 'lng', p.lng, 'geofence_radius', p.geofence_radius),
    'checkin', (
      select jsonb_build_object('inside_geofence', ci.inside_geofence,
                                'check_in_time', ci.check_in_time,
                                'check_out_time', ci.check_out_time)
      from public.worker_checkins ci
      where ci.booking_id = b.id and ci.worker_id = pw.id
    )
  )
  into payload
  from public.worker_checkin_tokens t
  join public.job_workers jw on jw.id = t.job_worker_id
  join public.provider_workers pw on pw.id = jw.worker_id
  join public.bookings b on b.id = jw.booking_id
  join public.properties p on p.id = b.property_id
  where t.token = p_token and jw.booking_id = p_booking_id
    and b.status <> 'cancelled';

  return payload;
end;
$$;
