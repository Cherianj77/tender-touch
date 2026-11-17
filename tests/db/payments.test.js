// Provider pricing, platform commission and held payments (database/provider_pricing.sql).
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
    await db.query('reset role'); await db.query(`select set_config('request.jwt.claims', '', true)`);
    await db.query('release savepoint s'); return out;
  } catch (e) { await db.query('rollback to savepoint s'); await db.query('reset role'); throw e; }
}
const tomorrow = "((now() at time zone 'Asia/Kolkata')::date + 1)";
const book = (service, time, status = 'confirmed') => as(U.owner, () => sql(
  `insert into bookings (owner_id, property_id, provider_id, service_type, scheduled_date, scheduled_time, status, amount)
   values ($1, $2, $3, $4, ${tomorrow}, $5, $6, 1) returning id, amount, provider_amount, commission_amount`,
  [U.owner, U.prop, U.provider, service, time, status]));
const pay = (bookingId, status = 'paid', amount = 1) => as(U.owner, () => sql(
  `insert into payments (booking_id, owner_id, provider_id, amount, status) values ($1, $2, $3, $4, $5)
   returning amount, provider_amount, commission_amount, status`, [bookingId, U.owner, U.provider, amount, status]));

before(async () => {
  await db.connect(); await db.query('begin');
  for (const [n, role] of [['owner', 'owner'], ['provider', 'provider'], ['other', 'provider']]) {
    const [{ id }] = await sql(`insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2) returning id`, [`${n}@pay.test`, { role }]);
    U[n] = id;
  }
  await sql(`insert into provider_services (provider_id, service_type, price_paise)
             values ($1, 'Plumbing Check', 120000), ($1, 'Security Check', 100000)`, [U.provider]);
  [{ id: U.prop }] = await as(U.owner, () => sql(`insert into properties (owner_id, name, city, lat, lng) values ($1, 'Villa', 'Kochi', 9.93, 76.26) returning id`, [U.owner]));
});
after(async () => { await db.query('rollback'); await db.end(); });

test('providers manage only their own price list; everyone signed in can read it', async () => {
  await as(U.provider, () => sql(`insert into provider_services (provider_id, service_type, price_paise) values ($1, 'Deep Cleaning', 200000)`, [U.provider]));
  await assert.rejects(as(U.other, () => sql(`insert into provider_services (provider_id, service_type, price_paise) values ($1, 'Pest Control', 100000)`, [U.provider])), /row-level security/);
  const changed = await as(U.other, () => sql(`update provider_services set price_paise = 10000 where provider_id = $1 returning id`, [U.provider]));
  assert.equal(changed.length, 0);
  assert.equal((await as(U.owner, () => sql(`select * from provider_services where provider_id = $1`, [U.provider]))).length, 3, 'owners can read price lists');
  await assert.rejects(as(U.provider, () => sql(`insert into provider_services (provider_id, service_type, price_paise) values ($1, 'Pest Control', 500)`, [U.provider])), /check/);
});

test('booking price = provider price + 10% commission, set by the server (browser amount ignored)', async () => {
  const [b] = await book('Deep Cleaning', '10:00');
  assert.deepEqual([b.amount, b.provider_amount, b.commission_amount], [220000, 200000, 20000]);
  // A service the provider does not list cannot be booked.
  await assert.rejects(book('Pest Control', '11:00'), /does not offer|standard/);
  const [{ q }] = await as(U.owner, () => sql(`select quote_booking($1, 'Deep Cleaning') as q`, [U.provider]));
  assert.equal(q.total_paise, 220000); assert.equal(q.listed, true); assert.equal(Number(q.commission_percent), 10);
});

test('providers can list a custom ("Other") service and owners can book it', async () => {
  await as(U.provider, () => sql(`insert into provider_services (provider_id, service_type, price_paise, description) values ($1, 'Water Tank Cleaning', 80000, 'Overhead tank up to 1000 L')`, [U.provider]));
  const [b] = await book('Water Tank Cleaning', '11:30');
  assert.deepEqual([b.amount, b.provider_amount, b.commission_amount], [88000, 80000, 8000]);
  await assert.rejects(as(U.provider, () => sql(`insert into provider_services (provider_id, service_type, price_paise) values ($1, 'x', 80000)`, [U.provider])), /check/);
  // Unlisting it stops new bookings but keeps the existing one.
  await as(U.provider, () => sql(`delete from provider_services where provider_id = $1 and service_type = 'Water Tank Cleaning'`, [U.provider]));
  await assert.rejects(book('Water Tank Cleaning', '12:30'), /does not offer/);
  assert.equal((await sql(`select count(*)::int n from bookings where id = $1`, [b.id]))[0].n, 1);
});

test('payment charges exactly the booking price; owner cannot release, change amount, or delete it', async () => {
  const [b] = await book('Deep Cleaning', '12:00');
  const [p] = await pay(b.id, 'paid', 5);
  assert.deepEqual([p.amount, p.provider_amount, p.commission_amount], [220000, 200000, 20000]);
  await assert.rejects(as(U.owner, () => sql(`update payments set status = 'released' where booking_id = $1`, [b.id])), /released to the provider automatically/);
  const [kept] = await as(U.owner, () => sql(`update payments set amount = 1 where booking_id = $1 returning amount`, [b.id]));
  assert.equal(kept.amount, 220000);
  await assert.rejects(as(U.owner, () => sql(`delete from payments where booking_id = $1`, [b.id])), /cannot be deleted/);
  await assert.rejects(as(U.owner, () => sql(`update payments set status = 'refunded' where booking_id = $1`, [b.id])), /not allowed/);
  await assert.rejects(pay((await book('Plumbing Check', '13:00'))[0].id, 'released'), /only be unpaid or paid/);
});

test('cancelling refunds the held money; the provider cannot touch payments', async () => {
  const [b] = await book('Deep Cleaning', '14:00');
  await pay(b.id);
  const none = await as(U.provider, () => sql(`update payments set status = 'released' where booking_id = $1 returning id`, [b.id]));
  assert.equal(none.length, 0, 'provider has no update rights on payments');
  await as(U.owner, async () => {
    await sql(`update bookings set status = 'cancelled' where id = $1`, [b.id]);
    await sql(`update payments set status = 'refunded', refunded_at = now() where booking_id = $1`, [b.id]);
  });
  assert.equal((await sql(`select status from payments where booking_id = $1`, [b.id]))[0].status, 'refunded');
});

test('pay later: an unpaid payment can be paid, then the booking confirmed', async () => {
  const [b] = await book('Security Check', '15:00', 'pending');
  await pay(b.id, 'unpaid');
  await as(U.owner, async () => {
    await sql(`update payments set status = 'paid', paid_at = now() where booking_id = $1`, [b.id]);
    await sql(`update bookings set status = 'confirmed' where id = $1`, [b.id]);
  });
});

test('verified completion releases the held money (system action)', async () => {
  const [b] = await book('Deep Cleaning', '16:00');
  await pay(b.id);
  await sql(`update bookings set status = 'completed' where id = $1`, [b.id]); // as the system, evidence rules tested elsewhere
  const [p] = await sql(`select status, provider_amount, commission_amount from payments where booking_id = $1`, [b.id]);
  assert.deepEqual([p.status, p.provider_amount, p.commission_amount], ['released', 200000, 20000]);
});
