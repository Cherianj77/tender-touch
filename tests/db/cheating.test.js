// Can a provider mark a job completed (and release payment) without doing the work?
// Each test tries one shortcut; all must be refused. The final test is the honest path.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const db = new Client({ host: process.env.PGHOST || '/tmp', port: Number(process.env.PGPORT || 54322), user: 'postgres', database: process.env.PGDATABASE || 'tt' });
const U = {};
const sql = async (t, p) => (await db.query(t, p)).rows;
async function as(uid, fn) {
  await db.query('savepoint s');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await db.query('set local role authenticated');
    const out = await fn();
    await db.query('reset role');
    await db.query(`select set_config('request.jwt.claims', '', true)`);
    await db.query('release savepoint s');
    return out;
  } catch (e) { await db.query('rollback to savepoint s'); await db.query('reset role'); throw e; }
}
// Each scenario runs on a fresh job and is rolled back afterwards.
async function scenario(fn) {
  await db.query('savepoint scenario');
  try {
    await sql(`alter table bookings disable trigger bookings_reject_past_date`);
    const [{ id }] = await sql(
      `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status)
       values ($1, $2, $3, 'Deep Cleaning', (now() at time zone 'Asia/Kolkata')::date, '10:00', 'confirmed') returning id`,
      [U.owner, U.prop, U.provider]);
    await sql(`alter table bookings enable trigger bookings_reject_past_date`);
    await sql(`insert into payments (booking_id, owner_id, provider_id, amount, status, paid_at) values ($1, $2, $3, 350000, 'paid', now())`, [id, U.owner, U.provider]);
    await fn(id);
  } finally { await db.query('rollback to savepoint scenario'); }
}
const complete = id => as(U.provider, async () => {
  await sql(`update bookings set status = 'in_progress' where id = $1 and status = 'confirmed'`, [id]);
  return sql(`update bookings set status = 'completed' where id = $1 returning status`, [id]);
});
const paymentStatus = async id => (await sql(`select status from payments where booking_id = $1`, [id]))[0].status;
const NEAR = [9.93121, 76.26731], FAR = [9.975, 76.2673];
const checkIn = (id, [lat, lng]) => as(U.provider, () => sql(
  `insert into visit_reports (booking_id, provider_id, check_in_lat, check_in_lng, checked_in_at) values ($1, $2, $3, $4, now())`, [id, U.provider, lat, lng]));
const checkOut = id => as(U.provider, () => sql(`update visit_reports set checked_out_at = now() where booking_id = $1`, [id]));
// Uploads a real file to the provider's folder and attaches it as the after photo.
async function afterPhoto(id) {
  const name = `${U.provider}/${id}_after_1.jpg`;
  await as(U.provider, async () => {
    await sql(`insert into storage.objects (bucket_id, name, owner) values ('visit-photos', $1, $2)`, [name, U.provider]);
    await sql(`update visit_reports set after_photo_url = $2, notes = 'Cleaned all rooms' where booking_id = $1`,
      [id, `https://proj.supabase.co/storage/v1/object/public/visit-photos/${name}`]);
  });
}
// Test-only time travel: pretend the check-in happened `mins` minutes ago.
async function backdate(id, mins) {
  await sql(`alter table visit_reports disable trigger user`);
  await sql(`update visit_reports set checked_in_at = now() - make_interval(mins => $2) where booking_id = $1`, [id, mins]);
  await sql(`alter table visit_reports enable trigger user`);
}
async function refused(id, re) {
  await assert.rejects(complete(id), re);
  assert.equal(await paymentStatus(id), 'paid', 'payment must stay held');
}

before(async () => {
  await db.connect(); await db.query('begin');
  for (const [n, meta, role] of [['owner', { role: 'owner' }], ['provider', { role: 'provider' }]]) {
    const [{ id }] = await sql(`insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2) returning id`, [`${n}@cheat.test`, meta]);
    U[n] = id;
  }
  if ((await sql(`select to_regclass('public.provider_services') as r`))[0].r) {
    await sql(`insert into provider_services (provider_id, service_type, price_paise) values ($1, 'Deep Cleaning', 350000)`, [U.provider]);
  }
  [{ id: U.prop }] = await as(U.owner, () => sql(
    `insert into properties (owner_id, name, city, lat, lng, geofence_radius) values ($1, 'Villa', 'Kochi', 9.9312, 76.2673, 100) returning id`, [U.owner]));
});
after(async () => { await db.query('rollback'); await db.end(); });

test('cheat 1: mark completed with no visit at all', () => scenario(async id => {
  await refused(id, /check in|visit/i);
}));

test('cheat 2: check in from 5 km away, then complete', () => scenario(async id => {
  await checkIn(id, FAR); await backdate(id, 60); await checkOut(id); await afterPhoto(id);
  await refused(id, /geo-fence|on site/i);
}));

test('cheat 3: drive-by visit of one minute', () => scenario(async id => {
  await checkIn(id, NEAR); await checkOut(id); await afterPhoto(id);
  await refused(id, /minutes/i);
}));

test('cheat 4: fake an earlier check-in time from the browser', () => scenario(async id => {
  await as(U.provider, () => sql(
    `insert into visit_reports (booking_id, provider_id, check_in_lat, check_in_lng, checked_in_at) values ($1, $2, $3, $4, now() - interval '3 hours')`,
    [id, U.provider, ...NEAR]));
  const [{ mins }] = await sql(`select extract(epoch from now() - checked_in_at) / 60 as mins from visit_reports where booking_id = $1`, [id]);
  assert.ok(Number(mins) < 1, 'the server must record the real check-in time');
  await checkOut(id); await afterPhoto(id);
  await refused(id, /minutes/i);
}));

test('cheat 5: no after photo', () => scenario(async id => {
  await checkIn(id, NEAR); await backdate(id, 60); await checkOut(id);
  await refused(id, /photo/i);
}));

test('cheat 6: after photo is just a link to some other image', () => scenario(async id => {
  await checkIn(id, NEAR); await backdate(id, 60); await checkOut(id);
  await as(U.provider, () => sql(`update visit_reports set after_photo_url = 'https://example.com/stock-clean-room.jpg' where booking_id = $1`, [id]));
  await refused(id, /photo/i);
}));

test('cheat 7: never checked out', () => scenario(async id => {
  await checkIn(id, NEAR); await backdate(id, 60); await afterPhoto(id);
  await refused(id, /check out/i);
}));

test('honest visit: on site, long enough, checked out, real after photo → completed and paid out', () => scenario(async id => {
  await checkIn(id, NEAR); await backdate(id, 45); await checkOut(id); await afterPhoto(id);
  const r = await complete(id);
  assert.equal(r[0].status, 'completed');
  assert.equal(await paymentStatus(id), 'released');
}));
