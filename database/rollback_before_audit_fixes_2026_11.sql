-- Tender Touch: ROLLBACK for audit_fixes_2026_11.sql
-- Exact definitions captured from the live project on 2026-11-17 before the fixes were applied.
-- To undo the fixes: run this file, then also run:
--   drop policy if exists "alerts_provider_insert" on public.alerts;

CREATE OR REPLACE FUNCTION public.delete_user_account(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    -- 1. Ensure the caller is an admin
    if not is_admin() then
        raise exception 'Unauthorized: Only admins can delete user accounts.';
    end if;

    -- 2. Prevent the admin from deleting their own account via this endpoint to prevent lockout
    if auth.uid() = target_user_id then
        raise exception 'Action Not Allowed: You cannot delete your own admin account. Please ask another admin to do it.';
    end if;

    -- 3. Scrub child records first to prevent Foreign Key Violation errors.
    -- Because some tables were created without ON DELETE CASCADE on auth.users refs,
    -- we manually delete the user's footprint across all known tables first.
    -- Note: Supabase restricts direct DELETE on storage.objects; S3 data is handled separately.
    delete from public.messages where sender_id = target_user_id or receiver_id = target_user_id;
    delete from public.provider_portfolio where provider_id = target_user_id;
    delete from public.provider_workers where provider_id = target_user_id;
    delete from public.visit_reports where provider_id = target_user_id;
    delete from public.inspections where inspector_id = target_user_id;
    delete from public.qa_assignments where inspector_id = target_user_id or owner_id = target_user_id;
    delete from public.alerts where owner_id = target_user_id;
    delete from public.payments where owner_id = target_user_id or provider_id = target_user_id;
    delete from public.bookings where owner_id = target_user_id or provider_id = target_user_id;
    delete from public.job_workers where assigned_by = target_user_id;
    delete from public.properties where owner_id = target_user_id;
    
    -- 4. Delete the root auth user (which will cascade to profiles).
    delete from auth.users where id = target_user_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_booking_updates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$
;

drop policy if exists alerts_admin_select on public.alerts;
create policy alerts_admin_select on public.alerts as PERMISSIVE for SELECT to public using (is_admin());

drop policy if exists provider_portfolios_upload on storage.objects;
create policy provider_portfolios_upload on storage.objects as PERMISSIVE for INSERT to public with check (((bucket_id = 'provider-portfolios'::text) AND (auth.role() = 'authenticated'::text)));

drop policy if exists provider_portfolios_delete on storage.objects;
create policy provider_portfolios_delete on storage.objects as PERMISSIVE for DELETE to public using (((bucket_id = 'provider-portfolios'::text) AND (auth.role() = 'authenticated'::text)));

drop policy if exists alerts_owner_all on public.alerts;
create policy alerts_owner_all on public.alerts as PERMISSIVE for ALL to public using (((auth.uid() = owner_id) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'owner'::text)))))) with check (((auth.uid() = owner_id) AND (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'owner'::text)))) AND ((property_id IS NULL) OR (EXISTS ( SELECT 1
   FROM properties p
  WHERE ((p.id = alerts.property_id) AND (p.owner_id = auth.uid())))))));
