-- ==============================================================================
-- Tender Touch: audit fixes (November 2026)
-- Additive and idempotent. Does not delete or rewrite any existing rows.
-- Back up the project first, then run this whole file in Supabase SQL Editor.
-- It was tested against a local replica of supabase_setup.sql (see tests/).
-- ==============================================================================

-- 1. Keep the phone number entered at sign-up. The trigger previously dropped it,
--    and initAuth() cannot fill it later because its upsert ignores existing rows.
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

  insert into public.profiles (id, first_name, last_name, phone, role)
  values (
    new.id,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name',
    nullif(trim(new.raw_user_meta_data->>'phone'), ''),
    signup_role
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- 2. Owners can confirm a pending booking once it has a paid payment.
--    Before this, paying for an existing pending booking marked the payment paid
--    but the trigger silently rejected the status change, leaving it pending forever.
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
    if actor_role is distinct from 'owner' or new.owner_id <> auth.uid()
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
  elsif actor_role = 'owner' then
    if (to_jsonb(new) - array['status', 'provider_id'])
         is distinct from (to_jsonb(old) - array['status', 'provider_id']) then
      raise exception 'Owners may only cancel, confirm a paid booking, or change its provider.'
        using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      if new.status = 'cancelled' then
        if old.status not in ('pending', 'confirmed') then
          raise exception 'Only pending or confirmed bookings can be cancelled.'
            using errcode = '22023';
        end if;
      elsif new.status = 'confirmed' and old.status = 'pending' then
        if not exists (
          select 1 from public.payments pm
          where pm.booking_id = new.id and pm.status = 'paid'
        ) then
          raise exception 'Pay for the booking before confirming it.' using errcode = '22023';
        end if;
      else
        raise exception 'Owners may only cancel, confirm a paid booking, or change its provider.'
          using errcode = '42501';
      end if;
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

-- 3. Providers may notify the owner of a booking assigned to them.
--    The provider dashboard sends check-in and report alerts, which RLS rejected.
drop policy if exists "alerts_provider_insert" on public.alerts;
create policy "alerts_provider_insert"
  on public.alerts for insert
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'provider')
    and exists (
      select 1 from public.bookings b
      where b.provider_id = auth.uid()
        and b.owner_id = alerts.owner_id
        and (alerts.property_id is null or b.property_id = alerts.property_id)
    )
  );

-- 4. Admin account deletion referenced a public.messages table that this
--    project never creates, so every deletion failed with "relation does not exist".
create or replace function public.delete_user_account(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Only admins can delete user accounts.' using errcode = '42501';
  end if;
  if auth.uid() = target_user_id then
    raise exception 'Action Not Allowed: You cannot delete your own admin account.' using errcode = '42501';
  end if;

  if to_regclass('public.messages') is not null then
    execute 'delete from public.messages where sender_id = $1 or receiver_id = $1' using target_user_id;
  end if;
  delete from public.provider_portfolio where provider_id = target_user_id;
  delete from public.verifications where inspector_id = target_user_id or owner_id = target_user_id;
  delete from public.inspections where inspector_id = target_user_id;
  delete from public.qa_assignments where inspector_id = target_user_id or owner_id = target_user_id;
  delete from public.visit_reports where provider_id = target_user_id;
  delete from public.alerts where owner_id = target_user_id;
  delete from public.payments where owner_id = target_user_id or provider_id = target_user_id;
  delete from public.job_workers where assigned_by = target_user_id;
  delete from public.bookings where owner_id = target_user_id or provider_id = target_user_id;
  delete from public.provider_workers where provider_id = target_user_id;
  delete from public.properties where owner_id = target_user_id;
  delete from auth.users where id = target_user_id;
end;
$$;
revoke all on function public.delete_user_account(uuid) from public, anon;
grant execute on function public.delete_user_account(uuid) to authenticated;

-- 5. Portfolio storage: any signed-in user could delete any provider's images.
--    Uploads already use "<user id>/<file>" paths; limit writes to that folder.
drop policy if exists "provider_portfolios_upload" on storage.objects;
create policy "provider_portfolios_upload" on storage.objects for insert
  with check (
    bucket_id = 'provider-portfolios'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "provider_portfolios_delete" on storage.objects;
create policy "provider_portfolios_delete" on storage.objects for delete
  using (
    bucket_id = 'provider-portfolios'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );
