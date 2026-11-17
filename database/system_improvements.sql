-- ==============================================================================
-- Tender Touch: System Improvements & Compatibility Migration
-- Safe to apply in Supabase SQL Editor. Does not alter or delete existing user data.
-- ==============================================================================

-- 1. Add specialization column to provider_workers
alter table public.provider_workers
  add column if not exists specialization text;

-- 2. Automatically release payments securely when a job is marked completed
create or replace function public.auto_release_payment_on_completion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'completed' and (old.status is distinct from 'completed') then
    update public.payments
    set status = 'released',
        released_at = coalesce(released_at, now())
    where booking_id = new.id
      and status = 'paid';
  end if;
  return new;
end;
$$;

revoke all on function public.auto_release_payment_on_completion() from public, anon, authenticated;
drop trigger if exists auto_release_payment_on_completion on public.bookings;
create trigger auto_release_payment_on_completion
  after update on public.bookings
  for each row
  execute function public.auto_release_payment_on_completion();

-- 3. Secure Admin Role Change RPC
-- Allows administrators to promote/demote account roles from the Admin Dashboard safely.
create or replace function public.admin_set_user_role(target_user_id uuid, new_role text)
returns json
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_admin() then
    raise exception 'Unauthorized: Only administrators can change roles.' using errcode = '42501';
  end if;

  if target_user_id = auth.uid() and new_role <> 'admin' then
    raise exception 'Administrators cannot remove their own administrator role.' using errcode = '42501';
  end if;

  if new_role not in ('owner', 'provider', 'qa_inspector', 'admin') then
    raise exception 'Invalid role.' using errcode = '22023';
  end if;

  update public.profiles
  set role = new_role
  where id = target_user_id;

  return json_build_object('status', 'success', 'user_id', target_user_id, 'role', new_role);
end;
$$;

revoke all on function public.admin_set_user_role(uuid, text) from public, anon;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;
