-- ================================================================
-- TENDER TOUCH — SUPABASE DATABASE SETUP
-- Run this entire script in: Supabase → SQL Editor → New Query
-- Review before applying to an existing database: this script changes policies and adds schema.
-- ================================================================

-- ─── 1. PROFILES TABLE ───────────────────────────────────────────
create table if not exists profiles (
  id         uuid references auth.users on delete cascade primary key,
  first_name text,
  last_name  text,
  phone      text,
  role       text default 'owner' check (role in ('owner','provider','worker','admin','qa_inspector')),
  avatar_url text,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

drop policy if exists "profiles_owner_select"  on profiles;
drop policy if exists "profiles_owner_update"  on profiles;
drop policy if exists "profiles_owner_insert"  on profiles;

create policy "profiles_owner_insert"
  on profiles for insert with check (auth.uid() = id);

create policy "profiles_owner_select"
  on profiles for select using (auth.uid() = id);

create policy "profiles_owner_update"
  on profiles for update using (auth.uid() = id);

-- NOTE: Admin access to profiles is handled via the service role key on the backend.
-- Avoid self-referencing policies on the profiles table (causes infinite recursion).

-- ─── 2. AUTO-CREATE PROFILE ON SIGNUP TRIGGER ───────────────────
-- EXCEPTION handler ensures signup NEVER fails even if profile insert errors
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, first_name, last_name, role)
  values (
    new.id,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name',
    coalesce(new.raw_user_meta_data->>'role', 'owner')
  )
  on conflict (id) do nothing;
  return new;
exception when others then
  -- Profile will be upserted on first dashboard load via initAuth()
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: create profile rows for any existing users who don't have one yet.
-- This fixes FK violations for users who signed up before the trigger was set up.
insert into profiles (id, role)
select id, 'owner' from auth.users
on conflict (id) do nothing;

-- ─── 3. PROPERTIES TABLE ─────────────────────────────────────────
create table if not exists properties (
  id               uuid default gen_random_uuid() primary key,
  owner_id         uuid references auth.users on delete cascade not null,
  name             text not null,
  address          text,
  city             text not null,
  state            text default 'Kerala',
  lat              double precision,
  lng              double precision,
  geofence_radius  integer default 200,
  property_type    text default 'house',
  is_active        boolean default true,
  created_at       timestamptz default now()
);

-- Safely add columns that may be missing on existing tables
alter table properties add column if not exists address        text;
alter table properties add column if not exists state          text default 'Kerala';
alter table properties add column if not exists lat            double precision;
alter table properties add column if not exists lng            double precision;
alter table properties add column if not exists geofence_radius integer default 200;
alter table properties add column if not exists property_type  text default 'house';
alter table properties add column if not exists is_active      boolean default true;

-- Fix the FK constraint: old tables may have owner_id → profiles instead of auth.users.
-- Drop the old constraint (whatever it's named) and recreate pointing to auth.users.
alter table properties drop constraint if exists properties_owner_id_fkey;
alter table properties drop constraint if exists property_owner_fkey;
alter table properties drop constraint if exists property_owner_id_fkey;
alter table properties
  add constraint properties_owner_id_fkey
  foreign key (owner_id) references auth.users on delete cascade;

alter table properties enable row level security;

drop policy if exists "properties_owner_all"        on properties;
drop policy if exists "properties_provider_select"  on properties;

create policy "properties_owner_all"
  on properties for all using (auth.uid() = owner_id);

-- NOTE: properties_provider_select is defined after the bookings table below.

-- ─── 4. BOOKINGS TABLE ───────────────────────────────────────────
create table if not exists bookings (
  id             uuid default gen_random_uuid() primary key,
  property_id    uuid references properties on delete cascade not null,
  owner_id       uuid references auth.users not null,
  provider_id    uuid references auth.users,
  service_type   text not null,
  scheduled_date date not null,
  status         text default 'pending' check (status in ('pending','confirmed','in_progress','completed','cancelled')),
  notes          text,
  created_at     timestamptz default now()
);

-- Historical bookings keep a null time because their exact visit time is unknown.
alter table bookings add column if not exists scheduled_time time;

alter table bookings enable row level security;

drop policy if exists "bookings_owner_all"      on bookings;
drop policy if exists "bookings_provider_select" on bookings;

create policy "bookings_owner_all"
  on bookings for all using (auth.uid() = owner_id);

create policy "bookings_provider_select"
  on bookings for select using (auth.uid() = provider_id);

-- Now safe to create this policy because bookings table exists
drop policy if exists "properties_provider_select" on properties;
create policy "properties_provider_select"
  on properties for select
  using (exists (
    select 1 from bookings b
    where b.property_id = properties.id and b.provider_id = auth.uid()
  ));

-- ─── 5. VISIT REPORTS TABLE ──────────────────────────────────────
create table if not exists visit_reports (
  id                  uuid default gen_random_uuid() primary key,
  booking_id          uuid references bookings on delete cascade not null,
  provider_id         uuid references auth.users not null,
  notes               text,
  checked_in_at       timestamptz,
  checked_out_at      timestamptz,
  check_in_lat        double precision,
  check_in_lng        double precision,
  inside_geofence     boolean,
  check_in_photo_url  text,
  before_photo_url    text,
  after_photo_url     text,
  condition           text,
  checklist           jsonb,
  created_at          timestamptz default now(),
  unique(booking_id, provider_id)
);

alter table visit_reports enable row level security;

drop policy if exists "visit_reports_provider_all"      on visit_reports;
drop policy if exists "visit_reports_owner_select"      on visit_reports;

create policy "visit_reports_provider_all"
  on visit_reports for all using (auth.uid() = provider_id);

create policy "visit_reports_owner_select"
  on visit_reports for select
  using (exists (
    select 1 from bookings b
    join properties p on b.property_id = p.id
    where b.id = visit_reports.booking_id and p.owner_id = auth.uid()
  ));

-- ─── 6. ALERTS TABLE ─────────────────────────────────────────────
create table if not exists alerts (
  id          uuid default gen_random_uuid() primary key,
  property_id uuid references properties on delete cascade,
  owner_id    uuid references auth.users not null,
  title       text not null,
  message     text,
  type        text default 'info' check (type in ('info','warning','danger','weather')),
  is_read     boolean default false,
  created_at  timestamptz default now()
);

alter table alerts enable row level security;

drop policy if exists "alerts_owner_all" on alerts;

create policy "alerts_owner_all"
  on alerts for all using (auth.uid() = owner_id);

-- ─── 7. INSPECTIONS TABLE ────────────────────────────────────────
create table if not exists inspections (
  id                uuid default gen_random_uuid() primary key,
  booking_id        uuid references bookings on delete cascade,
  inspector_id      uuid references auth.users not null,
  cleanliness_score integer check (cleanliness_score between 1 and 5),
  damage_score      integer check (damage_score between 1 and 5),
  security_score    integer check (security_score between 1 and 5),
  overall_score     integer check (overall_score between 1 and 5),
  notes             text,
  status            text default 'submitted' check (status in ('submitted','reviewed','approved')),
  created_at        timestamptz default now()
);

alter table inspections enable row level security;

drop policy if exists "inspections_inspector_all"   on inspections;
drop policy if exists "inspections_owner_select"    on inspections;

create policy "inspections_inspector_all"
  on inspections for all using (auth.uid() = inspector_id);

create policy "inspections_owner_select"
  on inspections for select
  using (exists (
    select 1 from bookings b
    join properties p on b.property_id = p.id
    where b.id = inspections.booking_id and p.owner_id = auth.uid()
  ));

-- ─── 8. QA ASSIGNMENTS TABLE ────────────────────────────────────
create table if not exists qa_assignments (
  id              uuid default gen_random_uuid() primary key,
  booking_id      uuid references bookings on delete cascade not null,
  inspector_id    uuid references auth.users not null,
  owner_id        uuid references auth.users not null,
  trigger_type    text default 'random' check (trigger_type in ('random','complaint','premium')),
  status          text default 'assigned' check (status in ('assigned','in_progress','completed')),
  assigned_at     timestamptz default now(),
  due_by          timestamptz,
  completed_at    timestamptz
);

alter table qa_assignments enable row level security;

drop policy if exists "qa_assignments_inspector_all" on qa_assignments;
drop policy if exists "qa_assignments_owner_select"  on qa_assignments;
drop policy if exists "qa_assignments_owner_insert"  on qa_assignments;

create policy "qa_assignments_inspector_all"
  on qa_assignments for all using (auth.uid() = inspector_id);

create policy "qa_assignments_owner_select"
  on qa_assignments for select using (auth.uid() = owner_id);

create policy "qa_assignments_owner_insert"
  on qa_assignments for insert with check (auth.uid() = owner_id);

-- ─── 9. VERIFICATIONS TABLE ─────────────────────────────────────
create table if not exists verifications (
  id                   uuid default gen_random_uuid() primary key,
  qa_assignment_id     uuid references qa_assignments on delete cascade not null,
  booking_id           uuid references bookings not null,
  inspector_id         uuid references auth.users not null,
  owner_id             uuid references auth.users not null,

  -- Checklist (true = pass, false = fail, null = not applicable)
  roof_verified        boolean,
  plumbing_verified    boolean,
  electrical_verified  boolean,
  garden_verified      boolean,
  security_verified    boolean,
  cleaning_verified    boolean,
  general_verified     boolean,

  -- Per-item notes
  roof_notes           text,
  plumbing_notes       text,
  electrical_notes     text,
  garden_notes         text,
  security_notes       text,
  cleaning_notes       text,

  -- Overall verdict
  verdict              text check (verdict in ('approved','failed','partial')),
  inspector_notes      text,
  created_at           timestamptz default now()
);

alter table verifications enable row level security;

drop policy if exists "verifications_inspector_all"   on verifications;
drop policy if exists "verifications_owner_select"    on verifications;

create policy "verifications_inspector_all"
  on verifications for all using (auth.uid() = inspector_id);

create policy "verifications_owner_select"
  on verifications for select using (auth.uid() = owner_id);

-- ─── 10. STORAGE BUCKETS ─────────────────────────────────────────
-- Go to Supabase Dashboard → Storage → New Bucket
--   Bucket name: visit-photos  |  Public: false
--   Bucket name: qa-photos     |  Public: false

-- ================================================================
-- DONE! All tables and policies created successfully.
-- ================================================================

-- ─── 11. WORKER ROLE ─────────────────────────────────────────────
-- Extend profiles to allow 'worker' role
alter table profiles
  drop constraint if exists profiles_role_check;

alter table profiles
  add constraint profiles_role_check
  check (role in ('owner','provider','worker','admin','qa_inspector'));

-- Allow owners & providers to look up workers by name for job assignment
drop policy if exists "profiles_lookup_by_name" on profiles;
create policy "profiles_lookup_by_name"
  on profiles for select
  using (
    auth.uid() is not null
    AND (auth.uid() = id OR role IN ('worker','provider','qa_inspector'))
  );

-- ─── 12. PROVIDER WORKERS TABLE ──────────────────────────────────
-- Field workers who don't have a Supabase auth account.
-- Provider adds them by name + phone; they check in via shared link.
-- MUST be created before job_workers and worker_checkins (they reference this table).
create table if not exists provider_workers (
  id          uuid default gen_random_uuid() primary key,
  provider_id uuid references profiles(id) on delete cascade not null,
  first_name  text not null,
  last_name   text,
  phone       text,
  created_at  timestamptz default now()
);

alter table provider_workers enable row level security;

drop policy if exists "pw_provider_all" on provider_workers;

-- Provider can fully manage their own workers
create policy "pw_provider_all"
  on provider_workers for all
  using  (auth.uid() = provider_id)
  with check (auth.uid() = provider_id);

-- ─── 13. JOB WORKERS ─────────────────────────────────────────────
-- Provider assigns workers to bookings
-- Preserve existing worker assignments when this setup script is run again.
create table if not exists job_workers (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid references bookings(id) on delete cascade not null,
  worker_id    uuid references provider_workers(id) on delete cascade not null,
  assigned_by  uuid references profiles(id) not null,
  assigned_at  timestamptz default now(),
  unique(booking_id, worker_id)
);

alter table job_workers enable row level security;

drop policy if exists "jw_provider_all"  on job_workers;
drop policy if exists "jw_worker_select" on job_workers;
drop policy if exists "jw_owner_select"  on job_workers;
drop policy if exists "jw_public_select" on job_workers;

-- Provider who assigned can do everything
create policy "jw_provider_all"
  on job_workers for all
  using (auth.uid() = assigned_by)
  with check (auth.uid() = assigned_by);

-- Anonymous workers use token-validated RPCs; do not expose job_workers directly.

-- Owner can see workers assigned to their properties' bookings
create policy "jw_owner_select"
  on job_workers for select
  using (
    exists (
      select 1 from bookings b
      where b.id = job_workers.booking_id
        and b.owner_id = auth.uid()
    )
  );

-- ─── 14. WORKER CHECK-INS ────────────────────────────────────────
-- Individual GPS check-in per worker per booking
-- Preserve existing check-in records when this setup script is run again.
create table if not exists worker_checkins (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid references bookings(id) on delete cascade not null,
  worker_id        uuid references provider_workers(id) on delete cascade not null,
  check_in_lat     double precision,
  check_in_lng     double precision,
  inside_geofence  boolean default false,
  check_in_time    timestamptz default now(),
  check_out_time   timestamptz,
  notes            text,
  unique(booking_id, worker_id)   -- one active row per worker per job
);

alter table worker_checkins enable row level security;

drop policy if exists "wc_worker_all"     on worker_checkins;
drop policy if exists "wc_public_all"     on worker_checkins;
drop policy if exists "wc_owner_select"   on worker_checkins;
drop policy if exists "wc_provider_select" on worker_checkins;

-- Anonymous workers write only through token-validated RPCs; no public table policy.

-- Owner sees check-ins for their properties' bookings
create policy "wc_owner_select"
  on worker_checkins for select
  using (
    exists (
      select 1 from bookings b
      where b.id = worker_checkins.booking_id
        and b.owner_id = auth.uid()
    )
  );

-- Provider sees check-ins for bookings they manage
create policy "wc_provider_select"
  on worker_checkins for select
  using (
    exists (
      select 1 from bookings b
      where b.id = worker_checkins.booking_id
        and b.provider_id = auth.uid()
    )
  );

-- Owner can read worker records for bookings on their properties
drop policy if exists "pw_owner_select" on provider_workers;
create policy "pw_owner_select"
  on provider_workers for select
  using (
    exists (
      select 1 from job_workers jw
      join bookings b on b.id = jw.booking_id
      where jw.worker_id = provider_workers.id
        and b.owner_id = auth.uid()
    )
  );

-- ================================================================
-- WORKER SYSTEM READY
-- ================================================================


-- ================================================================
-- FULL SCHEMA PATCH
-- ================================================================

-- ─── provider can update booking status ─────────────────────────
drop policy if exists "bookings_provider_update" on bookings;
create policy "bookings_provider_update"
  on bookings for update using (auth.uid() = provider_id);

-- ─── QA inspector can read bookings ─────────────────────────────
drop policy if exists "bookings_qa_select" on bookings;
create policy "bookings_qa_select"
  on bookings for select
  using (
    exists (
      select 1 from qa_assignments qa
      where qa.booking_id = bookings.id
        and qa.inspector_id = auth.uid()
    )
  );

-- ─── QA inspector can read properties via their assignment ───────
drop policy if exists "properties_qa_select" on properties;
create policy "properties_qa_select"
  on properties for select
  using (
    exists (
      select 1 from qa_assignments qa
      join bookings b on b.id = qa.booking_id
      where b.property_id = properties.id
        and qa.inspector_id = auth.uid()
    )
  );

-- ─── Storage buckets & Policies ─────────────────────────────────
insert into storage.buckets (id, name, public)
  values ('visit-photos', 'visit-photos', true)
  on conflict (id) do nothing;

drop policy if exists "ci_photo_insert" on storage.objects;
create policy "ci_photo_insert" on storage.objects for insert
  with check (bucket_id = 'visit-photos' and auth.role() = 'authenticated');

drop policy if exists "ci_photo_select" on storage.objects;
create policy "ci_photo_select" on storage.objects for select
  using (bucket_id = 'visit-photos');

-- Profiles: allow all authenticated users to read any profile
-- (needed so owner-bookings can load provider names)
drop policy if exists "profiles_read_all" on profiles;
create policy "profiles_read_all"
  on profiles for select
  using (auth.role() = 'authenticated');

-- ================================================================
-- SCHEMA COMPLETE
-- ================================================================

-- ─── ADMIN ROLE POLICIES & FUNCTIONS ──────────────────────────────
-- Fix: use a SECURITY DEFINER function which runs as the postgres
-- superuser and bypasses RLS entirely — zero recursion possible.
-- ================================================================

drop policy if exists "profiles_admin_all"          on profiles;
drop policy if exists "properties_admin_select"     on properties;
drop policy if exists "bookings_admin_all"           on bookings;
drop policy if exists "alerts_admin_select"          on alerts;
drop policy if exists "visit_reports_admin_select"   on visit_reports;
drop policy if exists "qa_assignments_admin_all"     on qa_assignments;
drop policy if exists "inspections_admin_select"     on inspections;
drop policy if exists "verifications_admin_select"   on verifications;

-- drop function if exists is_admin();
create or replace function is_admin()
  returns boolean
  language sql
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Recreate all admin policies using is_admin()

create policy "profiles_admin_all"  on profiles for all using (is_admin()) with check (is_admin());
create policy "properties_admin_select"  on properties for select using (is_admin());
create policy "bookings_admin_all"  on bookings for all using (is_admin()) with check (is_admin());
create policy "alerts_admin_select"  on alerts for select using (is_admin());
create policy "visit_reports_admin_select"  on visit_reports for select using (is_admin());
create policy "qa_assignments_admin_all"  on qa_assignments for all using (is_admin()) with check (is_admin());
create policy "inspections_admin_select"  on inspections for select using (is_admin());
create policy "verifications_admin_select"  on verifications for select using (is_admin());

-- ─── SECURE QA CREATION RPC ──────────────────────────────────────
-- Since frontend session collisions block admins from signing up others, 
-- this secure Postgres function directly creates auth users.
drop function if exists public.create_qa_user(text, text, text, text);
create or replace function public.create_qa_user(
  qa_email text,
  qa_password text,
  qa_first text,
  qa_last text
) returns json language plpgsql security definer set search_path = public as $$
declare
  new_uid uuid := gen_random_uuid();
  admin_check boolean;
begin
  select is_admin() into admin_check;
  if not admin_check then
    raise exception 'Unauthorized: Only admins can create QA accounts';
  end if;

  insert into auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at, 
    raw_user_meta_data, created_at, updated_at, role, aud
  ) values (
    new_uid, '00000000-0000-0000-0000-000000000000', qa_email, 
    extensions.crypt(qa_password, extensions.gen_salt('bf')), now(), 
    jsonb_build_object('first_name', qa_first, 'last_name', qa_last, 'role', 'qa_inspector'), 
    now(), now(), 'authenticated', 'authenticated'
  );

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), new_uid, new_uid::text, 
    jsonb_build_object('sub', new_uid::text, 'email', qa_email), 
    'email', now(), now(), now()
  );

  return json_build_object('status', 'success', 'user_id', new_uid);
end;
$$;


-- Administrator roles are assigned by the existing administrator through
-- the protected dashboard, or by a verified database administrator.


-- ================================================================
-- 15. PAYMENTS TABLE
-- Tracks demo payment lifecycle per booking.
-- ================================================================
alter table bookings add column if not exists amount integer;

create table if not exists payments (
  id              uuid default gen_random_uuid() primary key,
  booking_id      uuid references bookings(id) on delete cascade not null unique,
  owner_id        uuid references auth.users not null,
  provider_id     uuid references auth.users,
  amount          integer not null,               -- in paise (₹1500 = 150000)
  status          text default 'unpaid'
                  check (status in ('unpaid','paid','released','refunded')),
  paid_at         timestamptz,
  released_at     timestamptz,
  refunded_at     timestamptz,
  payment_method  text default 'demo_card',
  transaction_id  text,
  created_at      timestamptz default now()
);

alter table payments enable row level security;

drop policy if exists "payments_owner_all"      on payments;
drop policy if exists "payments_provider_select" on payments;
drop policy if exists "payments_admin_all"       on payments;

-- Owner can manage their own payments
create policy "payments_owner_all"
  on payments for all using (auth.uid() = owner_id);

-- Provider can read payments for bookings assigned to them
create policy "payments_provider_select"
  on payments for select
  using (auth.uid() = provider_id);

-- Admin can see all payments
create policy "payments_admin_all"
  on payments for all using (is_admin()) with check (is_admin());

-- ================================================================
-- PAYMENTS READY
-- ================================================================

-- ==============================================================================
-- 16. PROVIDER PORTFOLIO & LOCATION FEATURES
-- ==============================================================================
-- Add location and portfolio stats to the profiles table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS city text,
ADD COLUMN IF NOT EXISTS bio text,
ADD COLUMN IF NOT EXISTS experience_years integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS rating numeric DEFAULT 5.0,
ADD COLUMN IF NOT EXISTS completed_jobs integer DEFAULT 0;

-- Optionally, add a city to properties (if they don't use 'address' for filtering)
ALTER TABLE properties
ADD COLUMN IF NOT EXISTS city text;

-- Existing user and property rows are preserved; do not seed demo values into live data.

-- ============================================================================== 
-- 17. PROVIDER PORTFOLIO IMAGES / RECENT WORK 
-- ==============================================================================
-- Setup for providers to upload real photos of their work.

create table if not exists provider_portfolio (
  id uuid default gen_random_uuid() primary key,
  provider_id uuid references auth.users on delete cascade not null,
  title text not null,
  image_url text not null,
  created_at timestamptz default now()
);

alter table provider_portfolio enable row level security;

drop policy if exists "provider_portfolio_all_provider" on provider_portfolio;
drop policy if exists "provider_portfolio_read_all" on provider_portfolio;

-- Providers can manage their own portfolio
create policy "provider_portfolio_all_provider"
  on provider_portfolio for all using (auth.uid() = provider_id);

-- Everyone (authenticated) can view portfolios
create policy "provider_portfolio_read_all"
  on provider_portfolio for select using (auth.role() = 'authenticated');

-- Storage Bucket for portfolio images
insert into storage.buckets (id, name, public)
values ('provider-portfolios', 'provider-portfolios', true)
on conflict (id) do nothing;

drop policy if exists "provider_portfolios_upload" on storage.objects;
drop policy if exists "provider_portfolios_select" on storage.objects;
drop policy if exists "provider_portfolios_delete" on storage.objects;

create policy "provider_portfolios_upload" on storage.objects for insert
  with check (bucket_id = 'provider-portfolios' and auth.role() = 'authenticated');

create policy "provider_portfolios_delete" on storage.objects for delete
  using (bucket_id = 'provider-portfolios' and auth.role() = 'authenticated');

create policy "provider_portfolios_select" on storage.objects for select
  using (bucket_id = 'provider-portfolios');

-- ==============================================================================
-- 18. ADMIN USER COMPELTE DELETION 
-- ==============================================================================
-- This function allows admins to completely delete a user from the entire database.
-- It deletes the user from auth.users (which cascades to properties, bookings, tasks, logs, etc)

create or replace function public.delete_user_account(target_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
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
$$;




-- Secure worker-link migration. This section preserves existing assignments and check-ins.
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
    v_inside := true;
  else
    v_a := sin(radians(p_lat - v_prop_lat) / 2)^2
      + cos(radians(p_lat)) * cos(radians(v_prop_lat)) * sin(radians(p_lng - v_prop_lng) / 2)^2;
    v_distance := 6371000 * 2 * atan2(sqrt(v_a), sqrt(greatest(0, 1 - v_a)));
    v_inside := v_distance <= v_radius;
  end if;

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

-- Enforce service hours and prevent booking less than one hour ahead (Kerala time).
create or replace function public.reject_past_booking_date()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.scheduled_date < (pg_catalog.now() at time zone 'Asia/Kolkata')::date
     or new.scheduled_time is null
     or new.scheduled_time < time '08:00'
     or new.scheduled_time > time '17:30'
     or extract(minute from new.scheduled_time)::integer % 30 <> 0
     or extract(second from new.scheduled_time) <> 0 then
    raise exception 'Choose a date from today and a time between 08:00 and 17:30 Kerala time.'
      using errcode = '22007';
  end if;
  if new.scheduled_date = (pg_catalog.now() at time zone 'Asia/Kolkata')::date
     and (new.scheduled_date + new.scheduled_time) <
         ((pg_catalog.now() at time zone 'Asia/Kolkata') + interval '1 hour') then
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



-- ==============================================================================
-- System Improvements (Appended): Specialization, Auto-Payment Release, Role RPC
-- ==============================================================================

alter table public.provider_workers
  add column if not exists specialization text;

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
