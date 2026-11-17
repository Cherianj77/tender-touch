-- ==============================================================================
-- Tender Touch: Useful Read-Only Diagnostic Queries
-- Save and run in Supabase SQL Editor whenever you want to inspect project data.
-- ==============================================================================

-- 1. View all accounts by role
select p.first_name, p.last_name, p.role, u.email, p.created_at
from public.profiles p
join auth.users u on u.id = p.id
order by p.role, p.first_name;

-- 2. View all bookings and their assigned providers and owners
select b.id, b.service_type, b.scheduled_date, b.scheduled_time, b.status, b.notes,
       prop.name as property_name, prop.city,
       own.first_name || ' ' || coalesce(own.last_name, '') as owner_name,
       prov.first_name || ' ' || coalesce(prov.last_name, '') as provider_name
from public.bookings b
left join public.properties prop on prop.id = b.property_id
left join public.profiles own on own.id = b.owner_id
left join public.profiles prov on prov.id = b.provider_id
order by b.scheduled_date desc;

-- 3. View worker check-in links and assignment tokens
select t.token, jw.booking_id, pw.first_name as worker_name, pw.phone as worker_phone,
       b.service_type, prop.name as property_name
from public.worker_checkin_tokens t
join public.job_workers jw on jw.id = t.job_worker_id
join public.provider_workers pw on pw.id = jw.worker_id
join public.bookings b on b.id = jw.booking_id
join public.properties prop on prop.id = b.property_id;

-- 4. View QA inspection assignments
select qa.id, qa.status, qa.trigger_type, qa.due_by,
       insp.first_name || ' ' || coalesce(insp.last_name, '') as inspector_name,
       b.service_type, prop.name as property_name
from public.qa_assignments qa
join public.profiles insp on insp.id = qa.inspector_id
join public.bookings b on b.id = qa.booking_id
join public.properties prop on prop.id = b.property_id;
