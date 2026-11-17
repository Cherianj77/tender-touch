// Database integration tests: schema, triggers, RPCs and Row Level Security per role.
// Runs against a local Postgres replica built from database/supabase_setup.sql
// (+ database/audit_fixes_2026_11.sql). Never point this at the live project.
// Usage: PGDATABASE=tt node --test tests/db/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const db = new Client({
  host: process.env.PGHOST || '/tmp', port: Number(process.env.PGPORT || 54322),
  user: 'postgres', database: process.env.PGDATABASE || 'tt'
});

const U = {}; // fixture user ids by name
const tomorrow = "((now() at time zone 'Asia/Kolkata')::date + 1)";

async function sql(text, params) { return (await db.query(text, params)).rows; }

// Run fn as a Supabase API user (uid=null → anon). Everything runs inside a
// savepoint so failures and writes from one step don't leak into the next.
async function as(uid, fn, { rollback = false } = {}) {
  await db.query('savepoint s');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(uid ? { sub: uid, role: 'authenticated' } : { role: 'anon' })]);
    await db.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    const out = await fn();
    await db.query('reset role');
    await db.query(`select set_config('request.jwt.claims', '', true)`);
    await db.query(rollback ? 'rollback to savepoint s' : 'release savepoint s');
    return out;
  } catch (e) {
    await db.query('rollback to savepoint s');
    await db.query('reset role');
    throw e;
  }
}
const rejects = (uid, text, params, re) =>
  assert.rejects(as(uid, () => sql(text, params)), re);

// Move a booking to today, bypassing the booking-time rule (test setup only).
async function moveToToday(id) {
  await sql(`alter table bookings disable trigger bookings_reject_past_date`);
  await sql(`update bookings set scheduled_date = (now() at time zone 'Asia/Kolkata')::date where id = $1`, [id]);
  await sql(`alter table bookings enable trigger bookings_reject_past_date`);
}
// Record a genuine visit for a booking: on site, 30 minutes, checked out, real after photo.
// (Test setup as the database owner; the evidence rules are tested in cheating.test.js.)
async function giveEvidence(bookingId, providerId) {
  const name = `${providerId}/${bookingId}_after.jpg`;
  await sql(`insert into storage.objects (bucket_id, name) values ('visit-photos', $1)`, [name]);
  await sql(`delete from visit_reports where booking_id = $1`, [bookingId]);
  await sql(`insert into visit_reports (booking_id, provider_id, check_in_lat, check_in_lng, checked_in_at, checked_out_at, after_photo_url)
             select $1, $2, p.lat, p.lng, now() - interval '30 minutes', now(), $3
             from bookings b join properties p on p.id = b.property_id where b.id = $1`,
    [bookingId, providerId, `https://proj.supabase.co/storage/v1/object/public/visit-photos/${name}`]);
}
const hasTrigger = async name => (await sql(`select count(*)::int n from pg_trigger where tgname = $1`, [name]))[0].n > 0;

// Providers can only be booked for services they list; give test providers the standard list.
async function listStandardServices(providerId) {
  if (!(await sql(`select to_regclass('public.provider_services') as r`))[0].r) return;
  await sql(`insert into provider_services (provider_id, service_type, price_paise)
             select $1, s, public.standard_price_paise(s) from unnest(array['General Cleaning','Deep Cleaning','Plumbing Check','Electrical Check','Garden Maintenance','Pest Control','Monsoon Prep','Security Check','Full Inspection']) s
             on conflict do nothing`, [providerId]);
}

async function mkUser(name, meta, role) {
  const [{ id }] = await sql(
    `insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2) returning id`,
    [`${name}@test.local`, meta]);
  if (role) await sql(`update profiles set role = $1 where id = $2`, [role, id]);
  U[name] = id;
  return id;
}

before(async () => {
  await db.connect();
  await db.query('begin'); // whole suite rolls back at the end
  await mkUser('owner', { first_name: 'Asha', last_name: 'Nair', role: 'owner', phone: '+91 90000 00001' });
  await mkUser('owner2', { first_name: 'Ravi', role: 'owner' });
  await mkUser('provider', { first_name: 'Prakash', role: 'provider', phone: '+91 90000 00002' });
  await mkUser('provider2', { first_name: 'Other', role: 'provider' });
  await mkUser('qa', { first_name: 'Quinn' }, 'qa_inspector');
  await mkUser('admin', { first_name: 'Ada' }, 'admin');
  await mkUser('sneaky', { first_name: 'Eve', role: 'admin' }); // asks for admin at sign-up
  await listStandardServices(U.provider);
  await listStandardServices(U.provider2);

  // Owner's property (Kochi), plus one for owner2.
  [{ id: U.prop }] = await as(U.owner, () => sql(
    `insert into properties (owner_id, name, city, lat, lng, geofence_radius)
     values ($1, 'Mary''s Villa', 'Kochi', 9.9312, 76.2673, 200) returning id`, [U.owner]));
  [{ id: U.prop2 }] = await as(U.owner2, () => sql(
    `insert into properties (owner_id, name, city, lat, lng) values ($1, 'Other House', 'Thrissur', 10.52, 76.21) returning id`, [U.owner2]));
  // A paid, confirmed booking assigned to provider.
  [{ id: U.booking }] = await as(U.owner, () => sql(
    `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status, amount)
     values ($1, $2, $3, 'General Cleaning', ${tomorrow}, '10:00', 'confirmed', 150000) returning id`,
    [U.owner, U.prop, U.provider]));
  await as(U.owner, () => sql(
    `insert into payments (booking_id, owner_id, provider_id, amount, status, paid_at)
     values ($1, $2, $3, 150000, 'paid', now())`, [U.booking, U.owner, U.provider]));
});

after(async () => { await db.query('rollback'); await db.end(); });

// ── Sign-up and roles ─────────────────────────────────────────────
test('sign-up trigger creates an owner/provider profile and never grants admin', async () => {
  const rows = await sql(`select id, role from profiles where id = any($1)`, [[U.owner, U.provider, U.sneaky]]);
  const role = Object.fromEntries(rows.map(r => [r.id, r.role]));
  assert.equal(role[U.owner], 'owner');
  assert.equal(role[U.provider], 'provider');
  assert.equal(role[U.sneaky], 'owner');
});

test('sign-up trigger stores the phone number entered on the form', async () => {
  const [p] = await sql(`select phone from profiles where id = $1`, [U.owner]);
  assert.equal(p.phone, '+91 90000 00001');
});

test('users cannot promote themselves by editing profiles.role', async () => {
  await rejects(U.owner, `update profiles set role = 'admin' where id = $1`, [U.owner], /administrator|row-level security/);
  await rejects(U.provider, `update profiles set role = 'qa_inspector' where id = $1`, [U.provider], /administrator|row-level security/);
});

test('users can edit their own name and phone', async () => {
  const r = await as(U.provider, () => sql(
    `update profiles set first_name = 'Prakash', city = 'Kochi' where id = $1 returning city`, [U.provider]));
  assert.equal(r[0].city, 'Kochi');
});

test('admin can change roles through admin_set_user_role; others cannot', async () => {
  await rejects(U.owner, `select admin_set_user_role($1, 'admin')`, [U.owner], /Only administrators/);
  await as(U.admin, () => sql(`select admin_set_user_role($1, 'provider')`, [U.owner2]));
  const [p] = await sql(`select role from profiles where id = $1`, [U.owner2]);
  assert.equal(p.role, 'provider');
  await sql(`update profiles set role = 'owner' where id = $1`, [U.owner2]);
  await rejects(U.admin, `select admin_set_user_role($1, 'owner')`, [U.admin], /cannot remove their own/);
});

// ── Tenant isolation ──────────────────────────────────────────────
test('owners see only their own properties, bookings and payments', async () => {
  const props = await as(U.owner2, () => sql(`select id from properties`));
  assert.deepEqual(props.map(p => p.id), [U.prop2]);
  assert.equal((await as(U.owner2, () => sql(`select id from bookings`))).length, 0);
  assert.equal((await as(U.owner2, () => sql(`select id from payments`))).length, 0);
});

test('a provider sees only bookings assigned to them', async () => {
  assert.equal((await as(U.provider, () => sql(`select id from bookings`))).length, 1);
  assert.equal((await as(U.provider2, () => sql(`select id from bookings`))).length, 0);
  assert.equal((await as(U.provider2, () => sql(`select id from properties`))).length, 0);
});

test('anonymous visitors read no business tables', async () => {
  for (const t of ['properties', 'bookings', 'payments', 'visit_reports', 'job_workers', 'worker_checkins', 'worker_checkin_tokens']) {
    const rows = await as(null, () => sql(`select * from ${t}`)).catch(e => ({ denied: e.message }));
    assert.ok(rows.denied || rows.length === 0, `${t} leaked to anon`);
  }
});

// ── Booking rules ─────────────────────────────────────────────────
test('booking guard rejects past dates, out-of-hours and off-slot times', async () => {
  const ins = (date, time) => rejects(U.owner,
    `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status)
     values ($1, $2, $3, 'Plumbing Check', ${date}, $4, 'confirmed')`, [U.owner, U.prop, U.provider, time], /Kerala time|notice/);
  await ins(`((now() at time zone 'Asia/Kolkata')::date - 1)`, '10:00');
  await ins(tomorrow, '18:00');
  await ins(tomorrow, '07:30');
  await ins(tomorrow, '10:15');
});

test('owners cannot book against a non-provider or mark their booking completed', async () => {
  await rejects(U.owner,
    `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status)
     values ($1, $2, $3, 'Plumbing Check', ${tomorrow}, '11:00', 'confirmed')`, [U.owner, U.prop, U.owner2], /active service provider|does not offer/);
  await rejects(U.owner, `update bookings set status = 'completed' where id = $1`, [U.booking], /Owners may only|Check in at the property/);
});

test('owner can cancel a confirmed booking', async () => {
  const r = await as(U.owner, () => sql(`update bookings set status = 'cancelled' where id = $1 returning status`, [U.booking]),
    { rollback: true });
  assert.equal(r[0].status, 'cancelled');
});

test('owner can pay for a pending booking and then confirm it', async () => {
  await as(U.owner, async () => {
    const [{ id }] = await sql(
      `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status)
       values ($1, $2, $3, 'Pest Control', ${tomorrow}, '14:00', 'pending') returning id`, [U.owner, U.prop, U.provider]);
    await sql(`insert into payments (booking_id, owner_id, provider_id, amount, status) values ($1,$2,$3,250000,'paid')`,
      [id, U.owner, U.provider]);
    const r = await sql(`update bookings set status = 'confirmed' where id = $1 returning status`, [id]);
    assert.equal(r[0].status, 'confirmed');
  });
});

test('owner cannot confirm a pending booking without paying', async () => {
  await assert.rejects(as(U.owner, async () => {
    const [{ id }] = await sql(
      `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status)
       values ($1, $2, $3, 'Pest Control', ${tomorrow}, '15:00', 'pending') returning id`, [U.owner, U.prop, U.provider]);
    await sql(`update bookings set status = 'confirmed' where id = $1`, [id]);
  }), /Pay for the booking|Owners may only/);
});

// ── Provider visit flow ───────────────────────────────────────────
test('GPS check-in is refused before the day of the visit (provider and worker link)', async () => {
  if (!await hasTrigger('visit_reports_reject_early_checkin')) return; // provider_logic_fixes.sql not applied
  await rejects(U.provider,
    `insert into visit_reports (booking_id, provider_id, check_in_lat, check_in_lng, checked_in_at) values ($1, $2, 9.9312, 76.2673, now())`,
    [U.booking, U.provider], /Check-in opens on/);
  const tok = await as(U.provider, async () => {
    const [{ id: wid }] = await sql(`insert into provider_workers (provider_id, first_name) values ($1, 'Early') returning id`, [U.provider]);
    const [{ id: jw }] = await sql(`insert into job_workers (booking_id, worker_id, assigned_by) values ($1, $2, $3) returning id`, [U.booking, wid, U.provider]);
    return (await sql(`select token from worker_checkin_tokens where job_worker_id = $1`, [jw]))[0].token;
  });
  await assert.rejects(as(null, () => sql(`select worker_check_in($1, $2, 9.9312, 76.2673)`, [tok, U.booking])), /Check-in opens on/);
});

test('provider GPS check-in: geofence is recomputed by the database', async () => {
  await moveToToday(U.booking); // check-in is only allowed on the day of the visit
  await as(U.provider, async () => {
    // Browser claims "inside" from 5 km away; the trigger must overrule it.
    const [far] = await sql(
      `insert into visit_reports (booking_id, provider_id, check_in_lat, check_in_lng, inside_geofence, checked_in_at)
       values ($1, $2, 9.975, 76.2673, true, now()) returning inside_geofence`, [U.booking, U.provider]);
    assert.equal(far.inside_geofence, false);
    // The first check-in is evidence: its location cannot be moved afterwards.
    const [moved] = await sql(
      `update visit_reports set check_in_lat = 9.9313, check_in_lng = 76.2674 where booking_id = $1 returning inside_geofence, check_in_lat`, [U.booking]);
    if (await hasTrigger('aa_visit_report_server_times')) {
      assert.equal(moved.inside_geofence, false);
      assert.equal(moved.check_in_lat, 9.975);
    } else {
      assert.equal(moved.inside_geofence, true);
    }
  });
});

test('another provider cannot file a report on a job that is not theirs', async () => {
  await rejects(U.provider2,
    `insert into visit_reports (booking_id, provider_id, checked_in_at, check_in_lat, check_in_lng) values ($1, $2, now(), 9.93, 76.26)`,
    [U.booking, U.provider2], /row-level security|not assigned/);
});

test('provider completes job → payment auto-released; provider cannot edit other fields', async () => {
  await giveEvidence(U.booking, U.provider);
  await as(U.provider, async () => {
    await sql(`update bookings set status = 'in_progress' where id = $1`, [U.booking]);
    await sql(`update bookings set status = 'completed' where id = $1`, [U.booking]);
  });
  const [pm] = await sql(`select status, released_at from payments where booking_id = $1`, [U.booking]);
  assert.equal(pm.status, 'released');
  assert.ok(pm.released_at);
  // A completed job is closed to the provider: the update matches no rows or is rejected.
  const touched = await as(U.provider, () => sql(
    `update bookings set notes = 'x' where id = $1 returning id`, [U.booking])).catch(() => []);
  assert.equal(touched.length, 0);
  const [{ notes }] = await sql(`select notes from bookings where id = $1`, [U.booking]);
  assert.equal(notes, null);
});

test('provider can alert the owner of their booking but not unrelated owners', async () => {
  await as(U.provider, () => sql(
    `insert into alerts (owner_id, property_id, title, type) values ($1, $2, 'Provider checked in', 'info')`, [U.owner, U.prop]));
  await rejects(U.provider, `insert into alerts (owner_id, title) values ($1, 'spam')`, [U.owner2], /row-level security/);
  await rejects(U.provider2, `insert into alerts (owner_id, title) values ($1, 'spam')`, [U.owner], /row-level security/);
});

// ── Workers and secret check-in links ─────────────────────────────
test('worker assignment issues a token; anon check-in works only with the right token', async () => {
  const { wid, jwid } = await as(U.provider, async () => {
    const [{ id: wid }] = await sql(`insert into provider_workers (provider_id, first_name, phone) values ($1, 'Biju', '99') returning id`, [U.provider]);
    const [{ id: jwid }] = await sql(`insert into job_workers (booking_id, worker_id, assigned_by) values ($1, $2, $3) returning id`, [U.booking, wid, U.provider]);
    return { wid, jwid };
  });
  const [{ token }] = await as(U.provider, () => sql(`select token from worker_checkin_tokens where job_worker_id = $1`, [jwid]));
  assert.ok(token);
  assert.equal((await as(U.provider2, () => sql(`select * from worker_checkin_tokens`))).length, 0);

  // Re-open the job so check-in is allowed (previous test completed it).
  await sql(`update bookings set status = 'confirmed' where id = $1`, [U.booking]);

  const [{ payload }] = await as(null, () => sql(`select get_worker_checkin($1, $2) as payload`, [token, U.booking]));
  assert.equal(payload.worker.first_name, 'Biju');
  assert.equal(payload.property.name, "Mary's Villa");
  const [{ bad }] = await as(null, () => sql(`select get_worker_checkin(gen_random_uuid(), $1) as bad`, [U.booking]));
  assert.equal(bad, null);
  await assert.rejects(as(null, () => sql(`select worker_check_in(gen_random_uuid(), $1, 9.93, 76.26)`, [U.booking])), /Invalid worker check-in link/);

  const [{ r }] = await as(null, () => sql(`select worker_check_in($1, $2, 9.9312, 76.2673) as r`, [token, U.booking]));
  assert.equal(r.inside_geofence, true);
  const [b] = await sql(`select status from bookings where id = $1`, [U.booking]);
  assert.equal(b.status, 'in_progress');
  await as(null, () => sql(`select worker_check_out($1, $2)`, [token, U.booking]));
  await assert.rejects(as(null, () => sql(`select worker_check_out($1, $2)`, [token, U.booking])), /No active check-in/);
  // The owner sees the check-in and the worker's name.
  const seen = await as(U.owner, () => sql(`select w.first_name from worker_checkins c join provider_workers w on w.id = c.worker_id`));
  assert.deepEqual(seen.map(s => s.first_name), ['Biju']);
  assert.ok(wid);
});

test('a provider cannot assign another provider\'s worker', async () => {
  const [{ id: foreign }] = await as(U.provider2, () => sql(
    `insert into provider_workers (provider_id, first_name) values ($1, 'Mallory') returning id`, [U.provider2]));
  await rejects(U.provider, `insert into job_workers (booking_id, worker_id, assigned_by) values ($1, $2, $3)`,
    [U.booking, foreign, U.provider], /row-level security/);
});

// ── QA inspection flow ────────────────────────────────────────────
test('owner appoints QA; inspector inspects, submits verification and completes', async () => {
  const [{ id: qaId }] = await as(U.owner, () => sql(
    `insert into qa_assignments (booking_id, inspector_id, owner_id, trigger_type, due_by)
     values ($1, $2, $3, 'random', now() + interval '1 day') returning id`, [U.booking, U.qa, U.owner]));
  await rejects(U.owner, `insert into qa_assignments (booking_id, inspector_id, owner_id) values ($1, $2, $3)`,
    [U.booking, U.provider, U.owner], /row-level security/);

  const seen = await as(U.qa, () => sql(`select b.service_type, p.name from bookings b join properties p on p.id = b.property_id`));
  assert.deepEqual(seen, [{ service_type: 'General Cleaning', name: "Mary's Villa" }]);
  await as(U.qa, async () => {
    await sql(`insert into verifications (qa_assignment_id, booking_id, inspector_id, owner_id, verdict, roof_verified)
               values ($1, $2, $3, $4, 'approved', true)`, [qaId, U.booking, U.qa, U.owner]);
    await sql(`update qa_assignments set status = 'completed', completed_at = now() where id = $1`, [qaId]);
  });
  await rejects(U.qa, `update qa_assignments set inspector_id = $2 where id = $1`, [qaId, U.provider], /Inspectors may only|row-level security/);
  const v = await as(U.owner, () => sql(`select verdict from verifications`));
  assert.deepEqual(v.map(x => x.verdict), ['approved']);
  assert.equal((await as(U.owner2, () => sql(`select * from verifications`))).length, 0);
});

// ── Admin ─────────────────────────────────────────────────────────
test('admin reads everything; non-admins cannot call admin RPCs', async () => {
  for (const t of ['profiles', 'bookings', 'properties', 'payments', 'qa_assignments', 'alerts']) {
    assert.ok((await as(U.admin, () => sql(`select count(*)::int n from ${t}`)))[0].n > 0, t);
  }
  await rejects(U.owner, `select delete_user_account($1)`, [U.owner2], /Only admins/);
  await rejects(U.owner, `select create_qa_user('x@y.com', 'password1', 'X', 'Y')`, [], /Only admins/);
});

test('admin can create a QA inspector account', async () => {
  const [{ r }] = await as(U.admin, () => sql(`select create_qa_user('newqa@test.local', 'password123', 'Nina', 'K') as r`));
  const [p] = await sql(`select role, first_name from profiles where id = $1`, [r.user_id]);
  assert.deepEqual(p, { role: 'qa_inspector', first_name: 'Nina' });
});

test('admin can delete a user account with bookings and history', async () => {
  await as(U.admin, () => sql(`select delete_user_account($1)`, [U.owner]));
  assert.equal((await sql(`select count(*)::int n from auth.users where id = $1`, [U.owner]))[0].n, 0);
  assert.equal((await sql(`select count(*)::int n from bookings where owner_id = $1`, [U.owner]))[0].n, 0);
});

// ── Storage ───────────────────────────────────────────────────────
test('providers cannot delete another provider\'s portfolio images', async () => {
  await sql(`insert into storage.objects (bucket_id, name) values ('provider-portfolios', $1)`, [`${U.provider}/work.jpg`]);
  const gone = await as(U.provider2, () => sql(
    `delete from storage.objects where bucket_id = 'provider-portfolios' and name = $1 returning id`, [`${U.provider}/work.jpg`]));
  assert.equal(gone.length, 0);
  const mine = await as(U.provider, () => sql(
    `delete from storage.objects where bucket_id = 'provider-portfolios' and name = $1 returning id`, [`${U.provider}/work.jpg`]));
  assert.equal(mine.length, 1);
});

// ── Property photos (database/property_photos.sql) ────────────────
test('owners can attach a photo only to their own property and folder', async () => {
  const has = (await sql(`select count(*)::int n from information_schema.columns where table_name='properties' and column_name='photo_url'`))[0].n;
  if (!has) return; // migration not applied to this database
  const [{ id }] = await as(U.owner2, () => sql(`select id from properties limit 1`));
  const r = await as(U.owner2, () => sql(`update properties set photo_url = 'https://x/p.jpg' where id = $1 returning photo_url`, [id]));
  assert.equal(r[0].photo_url, 'https://x/p.jpg');
  const other = await as(U.provider, () => sql(`update properties set photo_url = 'evil' where id = $1 returning id`, [id]));
  assert.equal(other.length, 0, 'others cannot change it');
  await as(U.owner2, () => sql(`insert into storage.objects (bucket_id, name) values ('property-photos', $1)`, [`${U.owner2}/house.jpg`]));
  await rejects(U.owner2, `insert into storage.objects (bucket_id, name) values ('property-photos', $1)`, [`${U.provider}/house.jpg`], /row-level security/);
});

// ── Archived properties (database/property_archive.sql) ───────────
test('an archived property keeps its bookings but accepts no new ones', async () => {
  const has = (await sql(`select count(*)::int n from pg_trigger where tgname = 'bookings_reject_archived_property'`))[0].n;
  if (!has) return; // migration not applied to this database
  await as(U.owner2, async () => {
    const [{ id: pid }] = await sql(`insert into properties (owner_id, name, city, lat, lng) values ($1, 'Old Tharavad', 'Pala', 9.71, 76.68) returning id`, [U.owner2]);
    const [{ id: bid }] = await sql(
      `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status)
       values ($1, $2, $3, 'Security Check', ${tomorrow}, '09:00', 'pending') returning id`, [U.owner2, pid, U.provider]);
    await sql(`update properties set is_active = false where id = $1`, [pid]);
    assert.equal((await sql(`select count(*)::int n from bookings where id = $1`, [bid]))[0].n, 1, 'history kept');
    await sql('savepoint archived_insert');
    await assert.rejects(sql(
      `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status)
       values ($1, $2, $3, 'Security Check', ${tomorrow}, '10:00', 'pending')`, [U.owner2, pid, U.provider]), /has been removed/);
    await sql('rollback to savepoint archived_insert');
    await sql(`update properties set is_active = true where id = $1`, [pid]);
    await sql(`insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status)
       values ($1, $2, $3, 'Security Check', ${tomorrow}, '10:30', 'pending')`, [U.owner2, pid, U.provider]);
  }, { rollback: true });
});

test('a provider\'s completed-jobs count follows their completed bookings', async () => {
  if (!await hasTrigger('bookings_sync_completed_jobs')) return; // provider_logic_fixes.sql not applied
  const count = async () => (await sql(`select completed_jobs from profiles where id = $1`, [U.provider]))[0].completed_jobs;
  const before = await count();
  const [{ id }] = await as(U.owner2, () => sql(
    `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status)
     values ($1, $2, $3, 'Plumbing Check', ${tomorrow}, '11:00', 'confirmed') returning id`, [U.owner2, U.prop2, U.provider]));
  await moveToToday(id);
  await giveEvidence(id, U.provider);
  await as(U.provider, async () => {
    await sql(`update bookings set status = 'in_progress' where id = $1`, [id]);
    await sql(`update bookings set status = 'completed' where id = $1`, [id]);
  });
  assert.equal(await count(), before + 1);
});
