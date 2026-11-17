-- ==============================================================================
-- Tender Touch: property photos (November 2026)
-- Additive and idempotent. Adds an optional photo to each property.
-- ==============================================================================

alter table public.properties add column if not exists photo_url text;

-- Public bucket so photo URLs work in <img> tags, like visit-photos and provider-portfolios.
insert into storage.buckets (id, name, public)
values ('property-photos', 'property-photos', true)
on conflict (id) do nothing;

-- Owners may write only inside their own "<user id>/" folder.
drop policy if exists "property_photos_select" on storage.objects;
create policy "property_photos_select" on storage.objects for select
  using (bucket_id = 'property-photos');

drop policy if exists "property_photos_insert" on storage.objects;
create policy "property_photos_insert" on storage.objects for insert
  with check (
    bucket_id = 'property-photos'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "property_photos_delete" on storage.objects;
create policy "property_photos_delete" on storage.objects for delete
  using (
    bucket_id = 'property-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );
