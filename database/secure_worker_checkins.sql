-- Secure worker check-in links without deleting existing assignments or check-ins.
-- Review and run only after backing up this Supabase project.

-- Each assignment receives a secret UUID that is never exposed by the public tables.
create table if not exists public.worker_checkin_tokens (
  job_worker_id uuid primary key references public.job_workers(id) on delete cascade,
  provider_id uuid not null references public.profiles(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.worker_checkin_tokens enable row level security;
revoke all on table public.worker_checkin_tokens from public, anon, authenticated;
grant select on table public.worker_checkin_tokens to authenticated;
drop policy if exists worker_checkin_tokens_provider_select on public.worker_checkin_tokens;
create policy worker_checkin_tokens_provider_select
  on public.worker_checkin_tokens for select to authenticated
  using (auth.uid() = provider_id);

-- Backfill a fresh, unguessable token for each existing worker assignment.
insert into public.worker_checkin_tokens (job_worker_id, provider_id)
select jw.id, jw.assigned_by
from public.job_workers jw
on conflict (job_worker_id) do nothing;

-- New worker assignments get their own check-in link automatically.
create or replace function public.issue_worker_checkin_token()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.worker_checkin_tokens (job_worker_id, provider_id)
  values (new.id, new.assigned_by)
  on conflict (job_worker_id) do update set provider_id = excluded.provider_id;
  return new;
end;
$$;
revoke all on function public.issue_worker_checkin_token() from public, anon, authenticated;
drop trigger if exists issue_worker_checkin_token on public.job_workers;
create trigger issue_worker_checkin_token
  after insert on public.job_workers
  for each row execute function public.issue_worker_checkin_token();

-- Remove the broad anonymous table policies from the previous setup.
drop policy if exists jw_public_select on public.job_workers;
drop policy if exists wc_public_all on public.worker_checkins;

-- Anonymous links can read only the job details needed by a worker.
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

-- Record GPS check-in server-side and calculate the geofence from stored property coordinates.
create or replace function public.worker_check_in(
  p_token uuid, p_booking_id uuid, p_lat double precision, p_lng double precision
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_worker_id uuid;
  v_status text;
  v_prop_lat double precision;
  v_prop_lng double precision;
  v_radius double precision;
  v_inside boolean;
  v_a double precision;
  v_distance double precision;
  v_checked_in timestamptz;
  v_checked_out timestamptz;
begin
  if p_lat is null or p_lng is null or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'A valid GPS location is required';
  end if;

  select jw.worker_id, b.status, p.lat, p.lng, coalesce(p.geofence_radius, 100)
  into v_worker_id, v_status, v_prop_lat, v_prop_lng, v_radius
  from public.worker_checkin_tokens t
  join public.job_workers jw on jw.id = t.job_worker_id
  join public.bookings b on b.id = jw.booking_id
  join public.properties p on p.id = b.property_id
  where t.token = p_token and jw.booking_id = p_booking_id;

  if v_worker_id is null then raise exception 'Invalid worker check-in link'; end if;
  if v_status not in ('confirmed', 'in_progress') then raise exception 'This job is not open for check-in'; end if;

  if v_prop_lat is null or v_prop_lng is null then
    raise exception 'The property needs a map location before GPS check-in';
  end if;

  v_a := sin(radians(p_lat - v_prop_lat) / 2)^2
    + cos(radians(p_lat)) * cos(radians(v_prop_lat)) * sin(radians(p_lng - v_prop_lng) / 2)^2;
  v_distance := 6371000 * 2 * atan2(sqrt(v_a), sqrt(greatest(0, 1 - v_a)));
  v_inside := v_distance <= v_radius;

  insert into public.worker_checkins
    (booking_id, worker_id, check_in_lat, check_in_lng, inside_geofence, check_in_time)
  values
    (p_booking_id, v_worker_id, p_lat, p_lng, v_inside, now())
  on conflict (booking_id, worker_id) do update
    set check_in_lat = excluded.check_in_lat,
        check_in_lng = excluded.check_in_lng,
        inside_geofence = excluded.inside_geofence,
        check_in_time = excluded.check_in_time
    where public.worker_checkins.check_out_time is null
  returning check_in_time, check_out_time into v_checked_in, v_checked_out;

  if v_checked_in is null then raise exception 'This worker has already checked out'; end if;
  update public.bookings set status = 'in_progress'
    where id = p_booking_id and status = 'confirmed';

  return jsonb_build_object('inside_geofence', v_inside,
                            'check_in_time', v_checked_in,
                            'check_out_time', v_checked_out);
end;
$$;

create or replace function public.worker_check_out(p_token uuid, p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_worker_id uuid;
  v_checked_out timestamptz;
begin
  select jw.worker_id into v_worker_id
  from public.worker_checkin_tokens t
  join public.job_workers jw on jw.id = t.job_worker_id
  where t.token = p_token and jw.booking_id = p_booking_id;

  if v_worker_id is null then raise exception 'Invalid worker check-in link'; end if;

  update public.worker_checkins
  set check_out_time = now()
  where booking_id = p_booking_id and worker_id = v_worker_id and check_out_time is null
  returning check_out_time into v_checked_out;

  if v_checked_out is null then raise exception 'No active check-in was found'; end if;
  return jsonb_build_object('checked_out_at', v_checked_out);
end;
$$;

revoke all on function public.get_worker_checkin(uuid, uuid) from public;
revoke all on function public.worker_check_in(uuid, uuid, double precision, double precision) from public;
revoke all on function public.worker_check_out(uuid, uuid) from public;
grant execute on function public.get_worker_checkin(uuid, uuid) to anon, authenticated;
grant execute on function public.worker_check_in(uuid, uuid, double precision, double precision) to anon, authenticated;
grant execute on function public.worker_check_out(uuid, uuid) to anon, authenticated;
