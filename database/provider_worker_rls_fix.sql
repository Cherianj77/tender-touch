-- Fix the provider worker / job worker RLS recursion.
-- This preserves existing worker records and assignments.

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
