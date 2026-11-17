-- Tender Touch security hardening.
-- Apply after backing up the database. This does not delete application rows.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Signup metadata is user-controlled. Only owner/provider are self-service roles.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  signup_role text;
begin
  signup_role := case
    when new.raw_user_meta_data->>'role' = 'provider' then 'provider'
    else 'owner'
  end;

  insert into public.profiles (id, first_name, last_name, role)
  values (
    new.id,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name',
    signup_role
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  -- Keep signup resilient; initAuth creates a safe owner/provider profile if needed.
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Stop authenticated users from promoting themselves by writing profiles.role.
create or replace function public.guard_profile_role_changes()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and not public.is_admin() then
      if new.id <> auth.uid() or new.role not in ('owner', 'provider') then
        raise exception 'Only an administrator can assign this account role.'
          using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  if new.role is not distinct from old.role then
    return new;
  end if;

  -- SQL Editor/service administration has no end-user JWT; trusted DB actions remain available.
  if auth.uid() is null then
    return new;
  end if;

  if public.is_admin() then
    if auth.uid() = old.id and new.role <> 'admin' then
      raise exception 'Administrators cannot remove their own administrator role.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  raise exception 'Only an administrator can change account roles.'
    using errcode = '42501';
end;
$$;
revoke all on function public.guard_profile_role_changes() from public, anon, authenticated;
drop trigger if exists guard_profile_role_changes on public.profiles;
create trigger guard_profile_role_changes
  before insert or update on public.profiles
  for each row execute function public.guard_profile_role_changes();

-- Use database roles for routing and authorization; do not grant all-profile reads.
drop policy if exists "profiles_owner_insert" on public.profiles;
create policy "profiles_owner_insert"
  on public.profiles for insert
  with check (auth.uid() = id and role in ('owner', 'provider'));

drop policy if exists "profiles_owner_update" on public.profiles;
create policy "profiles_owner_update"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id and role in ('owner', 'provider'));

drop policy if exists "profiles_read_all" on public.profiles;
drop policy if exists "profiles_lookup_by_name" on public.profiles;
create policy "profiles_lookup_by_name"
  on public.profiles for select
  using (
    auth.uid() = id
    or role in ('provider', 'worker', 'qa_inspector')
  );

-- Provider dashboards may see only owners connected to one of their assigned jobs.
create or replace function public.is_related_owner_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.bookings b
    where b.owner_id = p_profile_id and b.provider_id = auth.uid()
  ) or exists (
    select 1 from public.qa_assignments qa
    where qa.owner_id = p_profile_id and qa.inspector_id = auth.uid()
  );
$$;
revoke all on function public.is_related_owner_profile(uuid) from public, anon;
grant execute on function public.is_related_owner_profile(uuid) to authenticated;
drop policy if exists "profiles_related_owner_select" on public.profiles;
create policy "profiles_related_owner_select"
  on public.profiles for select
  using (public.is_related_owner_profile(id));

-- Owners may manage only their own rows; providers may access only their assigned jobs.
drop policy if exists "properties_owner_all" on public.properties;
create policy "properties_owner_all"
  on public.properties for all
  using (
    auth.uid() = owner_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  )
  with check (
    auth.uid() = owner_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  );

drop policy if exists "bookings_owner_all" on public.bookings;
create policy "bookings_owner_all"
  on public.bookings for all
  using (
    auth.uid() = owner_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  )
  with check (
    auth.uid() = owner_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  );

drop policy if exists "bookings_provider_select" on public.bookings;
create policy "bookings_provider_select"
  on public.bookings for select
  using (
    auth.uid() = provider_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  );

drop policy if exists "bookings_provider_update" on public.bookings;
create policy "bookings_provider_update"
  on public.bookings for update
  using (
    auth.uid() = provider_id
    and status in ('confirmed', 'in_progress')
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  )
  with check (
    auth.uid() = provider_id
    and status in ('in_progress', 'completed')
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  );

drop policy if exists "properties_provider_select" on public.properties;
create policy "properties_provider_select"
  on public.properties for select
  using (
    exists (
      select 1 from public.bookings b
      where b.property_id = properties.id and b.provider_id = auth.uid()
    )
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  );

create or replace function public.guard_booking_updates()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_role text;
begin
  if auth.uid() is null or public.is_admin() then return new; end if;

  select p.role into actor_role from public.profiles p where p.id = auth.uid();
  if tg_op = 'INSERT' then
    if actor_role <> 'owner' or new.owner_id <> auth.uid()
       or new.status not in ('pending', 'confirmed') then
      raise exception 'Owners may create only their own pending or confirmed bookings.'
        using errcode = '42501';
    end if;
    if new.provider_id is not null and not exists (
      select 1 from public.profiles p where p.id = new.provider_id and p.role = 'provider'
    ) then
      raise exception 'Choose an active service provider.' using errcode = '23514';
    end if;
    return new;
  end if;

  if actor_role = 'provider' then
    if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status')
       or new.status not in ('in_progress', 'completed') then
      raise exception 'Providers may only update the status of their assigned job.'
        using errcode = '42501';
    end if;
  elsif actor_role = 'worker' then
    if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status')
       or old.status <> 'confirmed' or new.status <> 'in_progress' then
      raise exception 'Workers may only start a confirmed job through their check-in link.'
        using errcode = '42501';
    end if;
  elsif actor_role = 'owner' then
    if (to_jsonb(new) - array['status', 'provider_id'])
         is distinct from (to_jsonb(old) - array['status', 'provider_id'])
       or (new.status is distinct from old.status and new.status <> 'cancelled') then
      raise exception 'Owners may only cancel their booking or change its assigned provider.'
        using errcode = '42501';
    end if;
    if new.status = 'cancelled' and old.status not in ('pending', 'confirmed') then
      raise exception 'Only pending or confirmed bookings can be cancelled.'
        using errcode = '22023';
    end if;
    if new.provider_id is not null and not exists (
      select 1 from public.profiles p where p.id = new.provider_id and p.role = 'provider'
    ) then
      raise exception 'Choose an active service provider.' using errcode = '23514';
    end if;
  else
    raise exception 'This account role cannot update bookings.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_booking_updates() from public, anon, authenticated;
drop trigger if exists guard_booking_updates on public.bookings;
create trigger guard_booking_updates
  before insert or update on public.bookings
  for each row execute function public.guard_booking_updates();

drop policy if exists "visit_reports_provider_all" on public.visit_reports;
create policy "visit_reports_provider_all"
  on public.visit_reports for all
  using (
    auth.uid() = provider_id
    and exists (
      select 1 from public.bookings b
      where b.id = visit_reports.booking_id and b.provider_id = auth.uid()
    )
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  )
  with check (
    auth.uid() = provider_id
    and exists (
      select 1 from public.bookings b
      where b.id = visit_reports.booking_id and b.provider_id = auth.uid()
    )
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  );

-- Recompute geofence status in PostgreSQL instead of trusting browser-supplied booleans.
create or replace function public.validate_visit_report_checkin()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assigned_provider uuid;
  property_lat double precision;
  property_lng double precision;
  fence_radius double precision;
  distance_m double precision;
  a double precision;
begin
  if tg_op = 'UPDATE'
     and new.checked_in_at is not distinct from old.checked_in_at
     and new.check_in_lat is not distinct from old.check_in_lat
     and new.check_in_lng is not distinct from old.check_in_lng then
    new.inside_geofence := old.inside_geofence;
    return new;
  end if;

  if new.checked_in_at is null and new.check_in_lat is null and new.check_in_lng is null then
    new.inside_geofence := null;
    return new;
  end if;

  select b.provider_id, p.lat, p.lng, coalesce(p.geofence_radius, 200)
    into assigned_provider, property_lat, property_lng, fence_radius
  from public.bookings b
  join public.properties p on p.id = b.property_id
  where b.id = new.booking_id;

  if assigned_provider is null or assigned_provider <> new.provider_id then
    raise exception 'This provider is not assigned to the booking.' using errcode = '42501';
  end if;
  if property_lat is null or property_lng is null then
    raise exception 'The property needs a map location before GPS check-in.' using errcode = '22023';
  end if;
  if new.check_in_lat is null or new.check_in_lng is null
     or new.check_in_lat < -90 or new.check_in_lat > 90
     or new.check_in_lng < -180 or new.check_in_lng > 180 then
    raise exception 'A valid GPS location is required for check-in.' using errcode = '22023';
  end if;

  a := sin(radians(new.check_in_lat - property_lat) / 2)^2
     + cos(radians(new.check_in_lat)) * cos(radians(property_lat))
       * sin(radians(new.check_in_lng - property_lng) / 2)^2;
  distance_m := 6371000 * 2 * atan2(sqrt(a), sqrt(greatest(0, 1 - a)));
  new.inside_geofence := distance_m <= fence_radius;
  return new;
end;
$$;
revoke all on function public.validate_visit_report_checkin() from public, anon, authenticated;
drop trigger if exists validate_visit_report_checkin on public.visit_reports;
create trigger validate_visit_report_checkin
  before insert or update on public.visit_reports
  for each row execute function public.validate_visit_report_checkin();

-- A worker check-in cannot claim to be inside a fence when its property has no coordinates.
create or replace function public.worker_check_in(
  p_token uuid, p_booking_id uuid, p_lat double precision, p_lng double precision
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
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
    raise exception 'A valid GPS location is required' using errcode = '22023';
  end if;

  select jw.worker_id, b.status, p.lat, p.lng, coalesce(p.geofence_radius, 100)
    into v_worker_id, v_status, v_prop_lat, v_prop_lng, v_radius
  from public.worker_checkin_tokens t
  join public.job_workers jw on jw.id = t.job_worker_id
  join public.bookings b on b.id = jw.booking_id
  join public.properties p on p.id = b.property_id
  where t.token = p_token and jw.booking_id = p_booking_id;

  if v_worker_id is null then raise exception 'Invalid worker check-in link' using errcode = '42501'; end if;
  if v_status not in ('confirmed', 'in_progress') then
    raise exception 'This job is not open for check-in' using errcode = '22023';
  end if;
  if v_prop_lat is null or v_prop_lng is null then
    raise exception 'The property needs a map location before GPS check-in' using errcode = '22023';
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
revoke all on function public.worker_check_in(uuid, uuid, double precision, double precision) from public;
grant execute on function public.worker_check_in(uuid, uuid, double precision, double precision) to anon, authenticated;

drop policy if exists "alerts_owner_all" on public.alerts;
create policy "alerts_owner_all"
  on public.alerts for all
  using (
    auth.uid() = owner_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  )
  with check (
    auth.uid() = owner_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
    and (property_id is null or exists (
      select 1 from public.properties p where p.id = property_id and p.owner_id = auth.uid()
    ))
  );

-- QA inspectors may inspect their assignments, but cannot grant themselves work.
drop policy if exists "qa_assignments_inspector_all" on public.qa_assignments;
drop policy if exists "qa_assignments_inspector_select" on public.qa_assignments;
drop policy if exists "qa_assignments_inspector_update" on public.qa_assignments;
drop policy if exists "qa_assignments_owner_insert" on public.qa_assignments;
create policy "qa_assignments_inspector_select"
  on public.qa_assignments for select
  using (auth.uid() = inspector_id);
create policy "qa_assignments_inspector_update"
  on public.qa_assignments for update
  using (auth.uid() = inspector_id)
  with check (auth.uid() = inspector_id);
create policy "qa_assignments_owner_insert"
  on public.qa_assignments for insert
  with check (
    auth.uid() = owner_id
    and exists (select 1 from public.bookings b where b.id = booking_id and b.owner_id = auth.uid())
    and exists (select 1 from public.profiles p where p.id = inspector_id and p.role = 'qa_inspector')
  );

create or replace function public.guard_qa_assignment_updates()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if auth.uid() <> old.inspector_id
     or (to_jsonb(new) - array['status', 'completed_at'])
          is distinct from (to_jsonb(old) - array['status', 'completed_at'])
     or (old.status = 'completed' and new.status <> 'completed') then
    raise exception 'Inspectors may only update the status of their assigned inspection.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_qa_assignment_updates() from public, anon, authenticated;
drop trigger if exists guard_qa_assignment_updates on public.qa_assignments;
create trigger guard_qa_assignment_updates
  before update on public.qa_assignments
  for each row execute function public.guard_qa_assignment_updates();

-- A QA report must belong to a real assignment held by its inspector.
drop policy if exists "verifications_inspector_all" on public.verifications;
create policy "verifications_inspector_all"
  on public.verifications for all
  using (
    auth.uid() = inspector_id
    and exists (
      select 1 from public.qa_assignments qa
      where qa.id = verifications.qa_assignment_id
        and qa.booking_id = verifications.booking_id
        and qa.owner_id = verifications.owner_id
        and qa.inspector_id = auth.uid()
    )
  )
  with check (
    auth.uid() = inspector_id
    and exists (
      select 1 from public.qa_assignments qa
      where qa.id = verifications.qa_assignment_id
        and qa.booking_id = verifications.booking_id
        and qa.owner_id = verifications.owner_id
        and qa.inspector_id = auth.uid()
    )
  );

drop policy if exists "inspections_inspector_all" on public.inspections;
create policy "inspections_inspector_all"
  on public.inspections for all
  using (
    auth.uid() = inspector_id
    and exists (
      select 1 from public.qa_assignments qa
      where qa.booking_id = inspections.booking_id and qa.inspector_id = auth.uid()
    )
  )
  with check (
    auth.uid() = inspector_id
    and exists (
      select 1 from public.qa_assignments qa
      where qa.booking_id = inspections.booking_id and qa.inspector_id = auth.uid()
    )
  );

-- Provider-only management of field workers and assignments.
drop policy if exists "pw_provider_all" on public.provider_workers;
create policy "pw_provider_all"
  on public.provider_workers for all
  using (
    auth.uid() = provider_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  )
  with check (
    auth.uid() = provider_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  );

-- Avoid an RLS cycle: provider_workers has an owner-read policy that inspects
-- job_workers, so job_workers must not query provider_workers through RLS.
create or replace function public.is_owned_provider_worker(p_worker_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.provider_workers w
    where w.id = p_worker_id and w.provider_id = auth.uid()
  );
$$;
revoke all on function public.is_owned_provider_worker(uuid) from public, anon;
grant execute on function public.is_owned_provider_worker(uuid) to authenticated;

drop policy if exists "jw_provider_all" on public.job_workers;
create policy "jw_provider_all"
  on public.job_workers for all
  using (
    auth.uid() = assigned_by
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
    and exists (select 1 from public.bookings b where b.id = booking_id and b.provider_id = auth.uid())
    and public.is_owned_provider_worker(worker_id)
  )
  with check (
    auth.uid() = assigned_by
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
    and exists (select 1 from public.bookings b where b.id = booking_id and b.provider_id = auth.uid())
    and public.is_owned_provider_worker(worker_id)
  );

drop policy if exists worker_checkin_tokens_provider_select on public.worker_checkin_tokens;
create policy worker_checkin_tokens_provider_select
  on public.worker_checkin_tokens for select to authenticated
  using (
    auth.uid() = provider_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  );

drop policy if exists "payments_owner_all" on public.payments;
create policy "payments_owner_all"
  on public.payments for all
  using (
    auth.uid() = owner_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
  )
  with check (
    auth.uid() = owner_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner')
    and exists (select 1 from public.bookings b where b.id = booking_id and b.owner_id = auth.uid())
  );

drop policy if exists "provider_portfolio_all_provider" on public.provider_portfolio;
create policy "provider_portfolio_all_provider"
  on public.provider_portfolio for all
  using (
    auth.uid() = provider_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  )
  with check (
    auth.uid() = provider_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
  );

-- The QA account RPC may create only its fixed role after the safe signup trigger.
create or replace function public.create_qa_user(
  qa_email text, qa_password text, qa_first text, qa_last text
) returns json
language plpgsql
security definer
set search_path = pg_catalog, public, auth, extensions
as $$
declare
  new_uid uuid := gen_random_uuid();
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Only admins can create QA accounts' using errcode = '42501';
  end if;
  if qa_email is null or qa_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or qa_password is null or length(qa_password) < 8
     or nullif(trim(qa_first), '') is null then
    raise exception 'Enter a valid email, a password of at least 8 characters, and a first name.'
      using errcode = '22023';
  end if;

  insert into auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    raw_user_meta_data, created_at, updated_at, role, aud
  ) values (
    new_uid, '00000000-0000-0000-0000-000000000000', lower(trim(qa_email)),
    extensions.crypt(qa_password, extensions.gen_salt('bf')), now(),
    jsonb_build_object('first_name', trim(qa_first), 'last_name', trim(coalesce(qa_last, '')), 'role', 'qa_inspector'),
    now(), now(), 'authenticated', 'authenticated'
  );

  update public.profiles set role = 'qa_inspector' where id = new_uid;

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), new_uid, new_uid::text,
    jsonb_build_object('sub', new_uid::text, 'email', lower(trim(qa_email))),
    'email', now(), now(), now()
  );

  return json_build_object('status', 'success', 'user_id', new_uid);
end;
$$;
revoke all on function public.create_qa_user(text, text, text, text) from public, anon;
grant execute on function public.create_qa_user(text, text, text, text) to authenticated;

-- Admin roles are assigned by the existing admin or verified through SQL Editor;
-- no self-service admin-claim endpoint is exposed to browsers.
drop function if exists public.claim_admin_role();
