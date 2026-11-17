// Frontend integration tests: real page scripts + real supabase-js, faked network.
// Usage: node --test tests/frontend/   (TT_ROOT=<folder> to test another copy)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, when, rows } = require('./harness');

const OWNER = { id: '11111111-1111-4111-8111-111111111111', email: 'asha@test.local', user_metadata: { first_name: 'Asha' } };
const PROVIDER = { id: '22222222-2222-4222-8222-222222222222', email: 'pk@test.local', user_metadata: { first_name: 'Prakash' } };
const QA = { id: '33333333-3333-4333-8333-333333333333', email: 'qa@test.local', user_metadata: { first_name: 'Quinn' } };
const ADMIN = { id: '44444444-4444-4444-8444-444444444444', email: 'ada@test.local', user_metadata: { first_name: 'Ada' } };
const BOOKING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROP = 'pppppppp-pppp-4ppp-8ppp-pppppppppppp'.replace(/p/g, 'a');

const roleRoute = role => [when('GET', 'profiles', r => r.params.select === 'role'), req => rows(req, [{ role }])];
const XSS = '<img src=x onerror="window.__pwned=1">';

// ── Shared helpers ────────────────────────────────────────────────
test('shared-auth: booking slot rules, escaping and distance', async () => {
  const { w, close } = await loadPage('login.html', { scripts: ['js/supabase-config.js', 'js/shared-auth.js'], user: OWNER, routes: [roleRoute('owner')] });
  try {
    assert.equal(w.esc('<b>"x"</b>'), '&lt;b&gt;"x"&lt;/b&gt;');
    assert.equal(w.esc(null), '');
    const tomorrow = w.dateInputValueInKerala(1);
    assert.equal(w.isValidBookingDateTime(tomorrow, '08:00'), true);
    assert.equal(w.isValidBookingDateTime(tomorrow, '17:30'), true);
    assert.equal(w.isValidBookingDateTime(tomorrow, '17:45'), false);
    assert.equal(w.isValidBookingDateTime(tomorrow, '07:30'), false);
    assert.equal(w.isValidBookingDateTime(tomorrow, '10:15'), false);
    assert.equal(w.isValidBookingDateTime(w.dateInputValueInKerala(-1), '10:00'), false);
    assert.equal(w.isValidBookingDate('2026-02-30'), false);
    assert.equal(w.isValidBookingDate(''), false);
    assert.match(w.earliestBookingTimeToday(), /^\d{2}:(00|30)$/);
    assert.equal(Math.round(w.haversine(9.9312, 76.2673, 9.9312, 76.2673)), 0);
    const d = w.haversine(9.9312, 76.2673, 9.9402, 76.2673); // ~1 km north
    assert.ok(d > 990 && d < 1010, String(d));
    assert.equal(w.formatBookingDateTime('2026-12-01', '14:30'), '1 Dec 2026 · 2:30 pm IST');
    assert.equal(w.formatDate(null), '—');
  } finally { close(); }
});

test('dashboard guard: an owner opening the provider dashboard is redirected away', async () => {
  const page = await loadPage('provider-dashboard.html', {
    user: OWNER, scripts: ['js/supabase-config.js', 'js/shared-auth.js', 'js/provider-dashboard.js'], routes: [roleRoute('owner')],
  });
  try {
    assert.ok(!page.backend.calls.some(c => c.table === 'bookings'), 'provider data must not be requested for an owner');
  } finally { page.close(); }
});

test('confirmation dialog: cancel, confirm, Escape, and typed confirmation', async () => {
  const { w, doc, close } = await loadPage('login.html', { scripts: ['js/supabase-config.js', 'js/shared-auth.js'], user: null });
  try {
    const dlg = w.__realConfirmDialog;
    const btn = label => [...doc.querySelectorAll('[role=dialog] button')].find(b => b.textContent === label);
    let p = dlg('Remove it?', { okLabel: 'Remove' }); btn('Cancel').click(); assert.equal(await p, false);
    p = dlg('Remove it?', { okLabel: 'Remove' }); btn('Remove').click(); assert.equal(await p, true);
    p = dlg('Remove it?'); doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })); assert.equal(await p, false);
    p = dlg('Delete account?', { okLabel: 'Delete', requireText: 'DELETE' });
    const input = doc.querySelector('[role=dialog] input');
    btn('Delete').click(); // disabled until DELETE is typed
    assert.ok(doc.querySelector('[role=dialog]'), 'still open');
    input.value = 'DELETE'; input.dispatchEvent(new w.Event('input'));
    btn('Delete').click(); assert.equal(await p, true);
    assert.equal(doc.querySelector('[role=dialog]'), null, 'dialog removed');
  } finally { close(); }
});

// ── Provider ──────────────────────────────────────────────────────
function providerRoutes(extra = []) {
  const job = {
    id: BOOKING, owner_id: OWNER.id, provider_id: PROVIDER.id, property_id: PROP, service_type: 'General Cleaning',
    scheduled_date: '2099-01-01', scheduled_time: '10:00:00', status: 'in_progress', notes: null,
    properties: { id: PROP, name: "Mary's Villa", city: 'Kochi', lat: 9.93, lng: 76.26, geofence_radius: 200 },
  };
  return [
    roleRoute('provider'),
    ...extra,
    [when('GET', 'bookings'), req => rows(req, [job])],
    [when('GET', 'profiles', r => r.params.id?.startsWith('in.')), req => rows(req, [{ id: OWNER.id, first_name: 'Asha', last_name: 'N' }])],
    [when('GET', 'profiles'), req => rows(req, [{ id: PROVIDER.id, first_name: 'Prakash', role: 'provider' }])],
    [when('GET', 'visit_reports'), req => rows(req, [{ booking_id: BOOKING, checked_in_at: '2099-01-01T04:30:00Z', checked_out_at: '2099-01-01T06:00:00Z', inside_geofence: true }])],
    [when('GET', 'job_workers'), req => rows(req, [
      { id: 'jw-a', booking_id: BOOKING, worker_id: 'w-a', provider_workers: { first_name: 'Anu' } },
      { id: 'jw-b', booking_id: BOOKING, worker_id: 'w-b', provider_workers: { first_name: 'Babu' } }])],
    [when('GET', 'worker_checkin_tokens'), req => rows(req, [{ job_worker_id: 'jw-a', token: 'tok-a' }, { job_worker_id: 'jw-b', token: 'tok-b' }])],
    [when('GET', 'provider_workers'), req => rows(req, ['a', 'b', 'c'].map(x => ({ id: 'w-' + x, first_name: x.toUpperCase(), phone: '9' })))],
  ];
}
const providerScripts = ['js/supabase-config.js', 'js/shared-auth.js', 'js/provider-dashboard.js'];

test('provider: submitting a work report completes the job and notifies the owner', async () => {
  const page = await loadPage('provider-dashboard.html', { user: PROVIDER, scripts: providerScripts, routes: providerRoutes() });
  try {
    page.w.openReport(BOOKING);
    page.doc.getElementById('rNotes').value = 'All rooms cleaned';
    page.w.uploadVisitPhoto = async () => `https://x.supabase.co/storage/v1/object/public/visit-photos/${PROVIDER.id}/after.jpg`;
    page.w.eval("afterPhotoFile = new File(['x'], 'after.jpg', { type: 'image/jpeg' })");
    page.backend.calls.length = 0;
    await page.w.submitReport().catch(e => page.errors.push(e));
    await page.settle();
    const sent = page.backend.calls.map(c => `${c.method} ${c.table}`);
    assert.deepEqual(page.errors.map(String), [], 'no runtime errors');
    assert.ok(sent.includes('PATCH bookings'), 'booking marked completed');
    const alert = page.backend.calls.find(c => c.method === 'POST' && c.table === 'alerts');
    assert.ok(alert, 'owner alert sent');
    assert.equal(alert.body.owner_id, OWNER.id);
    assert.equal(page.doc.getElementById('reportModal').style.display, 'none', 'modal closed');
    assert.match(page.doc.getElementById('toast').textContent, /Report submitted/);
  } finally { page.close(); }
});

test('provider: a report without real visit evidence is stopped before anything is sent', async () => {
  const visits = {
    noPhoto: { checked_in_at: '2099-01-01T04:00:00Z', checked_out_at: '2099-01-01T05:00:00Z', inside_geofence: true },
    outside: { checked_in_at: '2099-01-01T04:00:00Z', checked_out_at: '2099-01-01T05:00:00Z', inside_geofence: false },
    short: { checked_in_at: '2099-01-01T04:00:00Z', checked_out_at: '2099-01-01T04:03:00Z', inside_geofence: true },
  };
  for (const [kind, visit] of Object.entries(visits)) {
    const page = await loadPage('provider-dashboard.html', { user: PROVIDER, scripts: providerScripts, routes: [
      [when('GET', 'visit_reports'), req => rows(req, [{ booking_id: BOOKING, ...visit }])], ...providerRoutes()] });
    try {
      page.w.openReport(BOOKING);
      page.w.uploadVisitPhoto = async () => 'https://x/visit-photos/a.jpg';
      if (kind !== 'noPhoto') page.w.eval("afterPhotoFile = new File(['x'], 'after.jpg', { type: 'image/jpeg' })");
      page.backend.calls.length = 0;
      await page.w.submitReport();
      const writes = page.backend.calls.filter(c => ['POST', 'PATCH'].includes(c.method));
      assert.deepEqual(writes, [], `${kind}: nothing saved`);
      const msg = page.doc.getElementById('toast').textContent;
      assert.match(msg, { noPhoto: /after photo/, outside: /geo-fence/, short: /at least 15 minutes/ }[kind], kind);
    } finally { page.close(); }
  }
});

test('provider: setting a price shows the 10% commission and asks to confirm it', async () => {
  const page = await loadPage('provider-dashboard.html', { user: PROVIDER, scripts: providerScripts, routes: [
    [when('GET', 'platform_settings'), req => rows(req, [{ value: 10 }])],
    [when('GET', 'provider_services'), req => rows(req, [])],
    ...providerRoutes()] });
  try {
    assert.match(page.doc.getElementById('commissionNote').textContent, /10% Tender Touch platform commission/);
    page.w.openServiceModal();
    page.doc.getElementById('svcType').value = 'Deep Cleaning';
    page.doc.getElementById('svcPrice').value = '2000';
    page.w.updateCommissionPreview();
    const preview = page.doc.getElementById('commissionPreview').textContent.replace(/\s+/g, ' ');
    assert.match(preview, /Platform commission: 10%/);
    assert.match(preview, /You receive: ₹2,000/);
    assert.match(preview, /commission \(10%\): ₹200/);
    assert.match(preview, /Owner pays: ₹2,200/);
    let asked = '';
    page.w.confirmDialog = async msg => { asked = msg; return false; };
    page.backend.calls.length = 0;
    await page.w.saveService();
    assert.match(asked, /10% platform commission \(₹200\), so owners will pay ₹2,200/);
    assert.equal(page.backend.calls.filter(c => c.method === 'POST').length, 0, 'not saved without agreeing');
    page.w.confirmDialog = async () => true;
    await page.w.saveService();
    const ins = page.backend.calls.find(c => c.method === 'POST' && c.table === 'provider_services');
    assert.equal([].concat(ins.body)[0].price_paise, 200000);
  } finally { page.close(); }
});

test('provider: can list a custom "Other" service by name', async () => {
  const page = await loadPage('provider-dashboard.html', { user: PROVIDER, scripts: providerScripts, routes: [
    [when('GET', 'platform_settings'), req => rows(req, [{ value: 10 }])],
    [when('GET', 'provider_services'), req => rows(req, [])],
    ...providerRoutes()] });
  try {
    assert.match(page.doc.getElementById('servicesList').textContent, /Owners can only book services you list/);
    page.w.openServiceModal();
    const sel = page.doc.getElementById('svcType');
    assert.ok([...sel.options].some(o => o.value === '__other'));
    sel.value = '__other'; page.w.toggleCustomService();
    assert.equal(page.doc.getElementById('svcCustom').style.display, 'block');
    page.doc.getElementById('svcCustom').value = '  Water   Tank Cleaning ';
    page.doc.getElementById('svcPrice').value = '800';
    page.w.confirmDialog = async () => true;
    page.backend.calls.length = 0;
    await page.w.saveService();
    const ins = page.backend.calls.find(c => c.method === 'POST' && c.table === 'provider_services');
    assert.equal([].concat(ins.body)[0].service_type, 'Water Tank Cleaning');
    assert.equal([].concat(ins.body)[0].price_paise, 80000);
  } finally { page.close(); }
});

test('provider: changing assigned workers keeps untouched workers\' check-in links', async () => {
  const page = await loadPage('provider-dashboard.html', { user: PROVIDER, scripts: providerScripts, routes: providerRoutes() });
  try {
    page.w.openAssign(BOOKING);      // currently A and B
    page.w.removeChip('w-b');
    page.w.addChip('w-c');           // now A and C
    page.backend.calls.length = 0;
    await page.w.saveAssign();
    await page.settle();
    const del = page.backend.calls.filter(c => c.method === 'DELETE' && c.table === 'job_workers');
    const ins = page.backend.calls.filter(c => c.method === 'POST' && c.table === 'job_workers');
    assert.equal(del.length, 1);
    assert.equal(del[0].params.worker_id, 'in.(w-b)', 'only the removed worker is unassigned');
    assert.deepEqual(ins.flatMap(c => [].concat(c.body)).map(r => r.worker_id), ['w-c'], 'only the new worker is inserted');
  } finally { page.close(); }
});

test('provider: profile photo can be added, changed and removed', async () => {
  const old = `https://x.supabase.co/storage/v1/object/public/provider-portfolios/${PROVIDER.id}/avatar-1.png`;
  let avatar = old;
  const routes = providerRoutes();
  // Own profile row (select *) carries the avatar.
  routes.splice(1, 0, [when('GET', 'profiles', r => r.params.select === '*'), req => rows(req, [{ id: PROVIDER.id, first_name: 'Prakash', role: 'provider', avatar_url: avatar }])]);
  routes.push([req => req.method === 'POST' && req.table.includes('/storage/v1/object/provider-portfolios/'), () => ({ body: { Key: 'k' } })]);
  const page = await loadPage('provider-dashboard.html', { user: PROVIDER, scripts: providerScripts, routes });
  try {
    const doc = page.doc;
    assert.equal(doc.getElementById('myAvatar').src, old, 'saved photo shown');
    assert.match(doc.getElementById('avatarActions').textContent, /Change photo[\s\S]*Remove photo/);
    page.backend.calls.length = 0;
    assert.equal(await page.w.uploadAvatar(new File(['x'], 'logo.png', { type: 'image/png' })), true);
    const up = page.backend.calls.find(c => c.method === 'POST' && c.table.includes('provider-portfolios'));
    assert.ok(up.table.includes(`/provider-portfolios/${PROVIDER.id}/avatar-`), 'uploaded into own folder');
    const patch = page.backend.calls.find(c => c.method === 'PATCH' && c.table === 'profiles');
    assert.match(patch.body.avatar_url, /avatar-\d+\.png$/);
    assert.ok(page.backend.calls.some(c => c.method === 'DELETE' && c.table.includes('/storage/v1/object/provider-portfolios')), 'old file cleaned up');
    page.backend.calls.length = 0;
    await page.w.removeAvatar();
    const rm = page.backend.calls.find(c => c.method === 'PATCH' && c.table === 'profiles');
    assert.equal(rm.body.avatar_url, null);
  } finally { page.close(); }
});

test('provider: worker check-in status, check-in opening day, and real earnings are shown', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const jobs = [
    { id: 'job-today', owner_id: OWNER.id, provider_id: PROVIDER.id, service_type: 'Deep Cleaning', scheduled_date: today, scheduled_time: '10:00:00', status: 'confirmed', amount: 350000, properties: { name: 'Today House', lat: 9.9, lng: 76.2, geofence_radius: 100 } },
    { id: 'job-future', owner_id: OWNER.id, provider_id: PROVIDER.id, service_type: 'Pest Control', scheduled_date: '2099-03-01', scheduled_time: '10:00:00', status: 'confirmed', properties: { name: 'Future House', lat: 9.9, lng: 76.2 } },
    { id: 'job-done', owner_id: OWNER.id, provider_id: PROVIDER.id, service_type: 'General Cleaning', scheduled_date: '2026-01-05', status: 'completed', properties: { name: 'Done House' } },
  ];
  const page = await loadPage('provider-dashboard.html', { user: PROVIDER, scripts: providerScripts, routes: [
    [when('GET', 'visit_reports'), req => rows(req, [])],
    [when('GET', 'job_workers'), req => rows(req, [
      { id: 'jw1', booking_id: 'job-today', worker_id: 'w-a', provider_workers: { first_name: 'Anu' } },
      { id: 'jw2', booking_id: 'job-today', worker_id: 'w-b', provider_workers: { first_name: 'Babu' } },
      { id: 'jw3', booking_id: 'job-today', worker_id: 'w-c', provider_workers: { first_name: 'Chinnu' } }])],
    [when('GET', 'worker_checkins'), req => rows(req, [
      { booking_id: 'job-today', worker_id: 'w-a', check_in_time: '2026-11-17T04:00:00Z', inside_geofence: true },
      { booking_id: 'job-today', worker_id: 'w-b', check_in_time: '2026-11-17T04:00:00Z', inside_geofence: false }])],
    [when('GET', 'payments'), req => rows(req, [
      { booking_id: 'job-done', amount: 150000, status: 'released' },
      { booking_id: 'job-today', amount: 350000, status: 'paid' }])],
    [when('GET', 'bookings'), req => rows(req, jobs)],
    ...providerRoutes().filter(r => !['visit_reports', 'job_workers', 'bookings'].some(t => r[0].toString().includes(t))),
  ] });
  try {
    const html = page.doc.getElementById('jobsList').textContent;
    assert.match(html, /Anu[\s\S]*On site since/);
    assert.match(html, /Babu[\s\S]*Outside fence/);
    assert.match(html, /Chinnu[\s\S]*Not checked in/);
    assert.ok(!/Assigned\s*$/m.test(html));
    const cards = [...page.doc.querySelectorAll('.job-card')];
    const future = cards.find(c => c.textContent.includes('Future House'));
    const todays = cards.find(c => c.textContent.includes('Today House'));
    assert.match(future.textContent, /Check-in opens on/);
    assert.ok(!future.textContent.includes('GPS Check-in'));
    assert.ok(todays.textContent.includes('GPS Check-in'));
    assert.match(todays.textContent, /You receive: ₹3,500[\s\S]*Held by Tender Touch/);
    assert.equal(page.doc.getElementById('s-earned').textContent, '₹1,500', 'only released payments count');
  } finally { page.close(); }
});

test('provider: cancelled jobs offer no check-in', async () => {
  const routes = providerRoutes([[when('GET', 'bookings'), req => rows(req, [{
    id: BOOKING, owner_id: OWNER.id, provider_id: PROVIDER.id, service_type: 'Deep Cleaning', scheduled_date: '2099-01-01',
    status: 'cancelled', properties: { name: 'Cancelled Cottage', lat: 9.9, lng: 76.2 } }])]]);
  // First matching route wins: no visit report exists for this job.
  const page = await loadPage('provider-dashboard.html', { user: PROVIDER, scripts: providerScripts, routes: [
    [when('GET', 'visit_reports'), req => rows(req, [])], ...routes] });
  try {
    const html = page.doc.getElementById('jobsList').innerHTML;
    assert.ok(html.includes('Cancelled Cottage'), 'the cancelled job card is rendered');
    for (const action of ['GPS Check-in', 'Check Out', 'Submit Report', 'Manage Workers']) {
      assert.ok(!html.includes(action), `no "${action}" on a cancelled job`);
    }
  } finally { page.close(); }
});

// ── Owner ─────────────────────────────────────────────────────────
const ownerScripts = ['js/supabase-config.js', 'js/shared-auth.js', 'js/owner-app.js'];

test('owner: QA inspector names are rendered as text, not HTML', async () => {
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [
    roleRoute('owner'),
    [when('GET', 'profiles', r => r.params.role === 'eq.qa_inspector'), req => rows(req, [{ id: QA.id, first_name: XSS, last_name: '' }])],
  ] });
  try {
    const sel = page.doc.getElementById('qaInspectorSelect');
    assert.equal(sel.querySelector('img'), null);
    assert.ok(sel.textContent.includes('<img'), 'name shown literally');
  } finally { page.close(); }
});

test('owner: paying for a pending booking records payment then confirms it, and reports failures', async () => {
  const pending = { id: BOOKING, owner_id: OWNER.id, provider_id: PROVIDER.id, property_id: PROP, service_type: 'Pest Control',
    scheduled_date: '2099-01-01', scheduled_time: '10:00:00', status: 'pending', properties: { name: 'Villa' } };
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [
    roleRoute('owner'),
    [when('GET', 'bookings', r => r.params.select === '*,properties(name)'), req => rows(req, [pending])],
    [when('PATCH', 'bookings'), () => ({ status: 400, body: { code: '22023', message: 'Pay for the booking before confirming it.' } })],
    [when('POST', 'rpc:quote_booking'), () => ({ body: { provider_paise: 250000, commission_paise: 25000, total_paise: 275000, commission_percent: 10, listed: false } })],
  ] });
  try {
    await page.w.app.bookings.load();
    const btn = [...page.doc.querySelectorAll('#bookingsTbody button')].find(b => b.textContent.includes('Pay'));
    assert.ok(btn, 'pending booking without a payment row offers Pay');
    btn.click();
    await page.settle();
    assert.equal(page.doc.getElementById('paymentModal').style.display, 'flex');
    page.backend.calls.length = 0;
    await page.w.app.confirmPayment();
    await page.settle();
    const pay = page.backend.calls.find(c => c.method === 'POST' && c.table === 'payments');
    assert.ok(pay, 'payment saved');
    assert.equal(pay.body.status, 'paid');
    assert.equal(pay.body.amount, 275000, 'price + 10% commission from the server');
    assert.ok(page.backend.calls.some(c => c.method === 'PATCH' && c.table === 'bookings'), 'confirm attempted');
    assert.match(page.doc.getElementById('toast').textContent, /could not be confirmed/, 'failure is reported, not hidden');
  } finally { page.close(); }
});

test('owner: cancelling an unpaid booking does not mark it refunded', async () => {
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [
    roleRoute('owner'),
    [when('GET', 'payments'), req => rows(req, [{ booking_id: BOOKING, status: 'unpaid', amount: 150000 }])],
  ] });
  try {
    page.backend.calls.length = 0;
    await page.w.app.bookings.cancelBooking(BOOKING);
    await page.settle();
    const payPatch = page.backend.calls.find(c => c.method === 'PATCH' && c.table === 'payments');
    assert.equal(payPatch, undefined);
  } finally { page.close(); }
});

test('owner: AI assistant asks only for provider columns that exist', async () => {
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [roleRoute('owner')] });
  try {
    // The live owner-app.html no longer contains the chat panel (see report); add the elements the script uses.
    page.doc.body.insertAdjacentHTML('beforeend', '<div id="aiChatBody"></div><div id="aiChatTyping"></div><textarea id="aiChatInput"></textarea><button id="aiChatSend"></button>');
    page.w.app.geminiKey = 'test-key';
    page.doc.getElementById('aiChatInput').value = 'Who can clean my villa?';
    page.backend.calls.length = 0;
    await page.w.app.sendChatMessage();
    const provQ = page.backend.calls.find(c => c.table === 'profiles' && c.params.role === 'eq.provider');
    assert.ok(provQ);
    for (const col of provQ.params.select.split(',')) {
      assert.ok(['id', 'first_name', 'last_name', 'city', 'bio', 'experience_years', 'phone', 'rating', 'completed_jobs'].includes(col), `unknown column ${col}`);
    }
    const gem = page.backend.calls.find(c => c.table.includes('generativelanguage') || c.table.includes('models'));
    assert.ok(gem && !gem.table.includes('1.5'), 'not the retired gemini-1.5 model');
  } finally { page.close(); }
});

test('owner: removing a property archives it when it has history, refuses with open visits, deletes when empty; restore works', async () => {
  const props = [
    { id: 'p-hist', name: 'houseex', city: 'Kaipuzha', is_active: true },
    { id: 'p-open', name: 'Busy House', city: 'Kochi', is_active: true },
    { id: 'p-empty', name: 'Lakeview Cottage', city: 'Kumarakom', is_active: true },
    { id: 'p-old', name: 'Old Tharavad', city: 'Pala', is_active: false },
  ];
  // Content-Range carries the count. "Open" requests filter by status.
  const counts = { 'p-hist': [3, 0], 'p-open': [2, 1], 'p-empty': [0, 0] };
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [
    roleRoute('owner'),
    [when('GET', 'properties'), req => rows(req, props)],
    [req => req.method === 'HEAD' && req.table === 'bookings', req => {
      const [all, open] = counts[req.params.property_id.slice(3)];
      return { body: [], headers: { 'content-range': `*/${req.params.status ? open : all}` } };
    }],
  ] });
  try {
    await page.w.app.properties.load();
    const grid = page.doc.getElementById('propGrid').textContent;
    assert.ok(!grid.includes('Old Tharavad'), 'archived property hidden from the grid');
    assert.match(page.doc.getElementById('archivedProps').textContent, /Removed properties \(1\)[\s\S]*Old Tharavad/);
    const calls = () => page.backend.calls.filter(c => ['DELETE', 'PATCH'].includes(c.method) && c.table === 'properties');

    page.backend.calls.length = 0;
    await page.w.app.properties.removeProperty('p-open');
    assert.equal(calls().length, 0, 'open visits block removal');
    assert.match(page.doc.getElementById('toast').textContent, /upcoming or in-progress/);

    let shown = '';
    page.w.confirmDialog = async msg => { shown = msg; return true; };
    page.backend.calls.length = 0;
    await page.w.app.properties.removeProperty('p-hist');
    assert.match(shown, /history will NOT be deleted/);
    assert.match(shown, /3 past bookings/);
    assert.deepEqual(calls().map(c => [c.method, c.params.id, c.body?.is_active]), [['PATCH', 'eq.p-hist', false]], 'archived, not deleted');

    page.backend.calls.length = 0;
    await page.w.app.properties.removeProperty('p-empty');
    assert.match(shown, /deleted permanently/);
    assert.deepEqual(calls().map(c => [c.method, c.params.id]), [['DELETE', 'eq.p-empty']]);

    page.w.confirmDialog = async () => false; // "second chance": cancelling changes nothing
    page.backend.calls.length = 0;
    await page.w.app.properties.removeProperty('p-hist');
    assert.equal(calls().length, 0);

    page.backend.calls.length = 0;
    await page.w.app.properties.restoreProperty('p-old');
    assert.deepEqual(calls().map(c => [c.method, c.params.id, c.body?.is_active]), [['PATCH', 'eq.p-old', true]]);
  } finally { page.close(); }
});

test('owner: property cards show photo, else mini map, else placeholder; photo upload saves URL', async () => {
  const props = [
    { id: 'p-photo', name: 'With Photo', city: 'Kochi', lat: 9.9, lng: 76.2, photo_url: 'https://cdn.example/x.jpg' },
    { id: 'p-map', name: 'With Pin', city: 'Kochi', lat: 9.9, lng: 76.2, geofence_radius: 100 },
    { id: 'p-none', name: 'No Pin', city: 'Kochi' },
  ];
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [
    roleRoute('owner'),
    [when('GET', 'properties'), req => rows(req, props)],
    [req => req.method === 'POST' && req.table.includes('/storage/v1/object/property-photos/'), () => ({ body: { Key: 'k' } })],
  ] });
  try {
    await page.w.app.properties.load();
    const cards = [...page.doc.querySelectorAll('.prop-card-full')];
    assert.ok(cards[0].querySelector('img.prop-card-photo'), 'photo shown');
    assert.ok(cards[1].querySelector('.prop-card-minimap'), 'mini map for pinned property');
    assert.ok(!cards[2].querySelector('img, .prop-card-minimap'), 'placeholder when no pin');
    assert.match(cards[0].textContent, /Change photo/);
    assert.match(cards[1].textContent, /Add photo/);
    page.backend.calls.length = 0;
    // Node's File: supabase-js runs in Node here and checks for Node's Blob type.
    const file = new File(['x'], 'house.png', { type: 'image/png' });
    const url = await page.w.app.properties.uploadPhoto('p-map', file);
    const up = page.backend.calls.find(c => c.method === 'POST' && c.table.includes('property-photos'));
    assert.ok(up && up.table.includes(`/property-photos/${OWNER.id}/p-map-`), 'uploaded into the owner\'s folder');
    const patch = page.backend.calls.find(c => c.method === 'PATCH' && c.table === 'properties');
    assert.equal(patch.body.photo_url, url);
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.jpg', { type: 'image/jpeg' });
    assert.equal(await page.w.app.properties.uploadPhoto('p-map', big), null, 'over 5 MB refused');
  } finally { page.close(); }
});

test('owner: add-property search suggests places, fills city/district, and "Other" type is saved', async () => {
  const photon = { features: [
    { geometry: { coordinates: [76.5063, 9.6694] }, properties: { name: 'Kaipuzha', osm_value: 'village', county: 'Kottayam', state: 'Kerala' } },
    { geometry: { coordinates: [76.6730, 9.2364] }, properties: { name: 'Kaipuzha', osm_value: 'local_authority', city: 'Kozhencherry', county: 'Pathanamthitta', state: 'Kerala' } },
  ] };
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [
    roleRoute('owner'),
    [req => req.table === '/api/', () => ({ body: photon })],
    [when('POST', 'properties'), req => rows(req, [{ id: 'new-prop' }])],
  ] });
  try {
    const w = page.w, doc = page.doc;
    w.app.openAddPropertyModal();
    await new Promise(r => setTimeout(r, 150));
    w.app.properties.mapPicker = { setView() {}, removeLayer() {} }; // map is stubbed in tests
    const input = doc.getElementById('mapSearch');
    input.value = 'kai'; w.app.properties.suggest('kai');
    await new Promise(r => setTimeout(r, 450));
    const items = doc.querySelectorAll('#mapSuggest .map-suggest-item');
    assert.equal(items.length, 2, 'two suggestions shown');
    assert.match(items[1].textContent, /Pathanamthitta/);
    // keyboard: down, down, enter → second result
    for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) w.app.properties.onSearchKey(new w.KeyboardEvent('keydown', { key }));
    assert.equal(doc.getElementById('propLat').value, '9.2364');
    assert.equal(doc.getElementById('propCity').value, 'Kozhencherry');
    assert.equal(doc.getElementById('propDistrict').value, 'Pathanamthitta');
    assert.ok(doc.getElementById('mapSuggest').hidden, 'list closes after choosing');
    // "Other" type with a description
    const typeSel = doc.getElementById('propType');
    typeSel.value = 'Other'; typeSel.onchange();
    assert.equal(doc.getElementById('propTypeOther').style.display, 'block');
    doc.getElementById('propTypeOther').value = 'Farmhouse';
    doc.getElementById('propName').value = 'River Farm';
    page.backend.calls.length = 0;
    await w.app.properties.saveProperty();
    const ins = page.backend.calls.find(c => c.method === 'POST' && c.table === 'properties');
    assert.equal([].concat(ins.body)[0].property_type, 'Farmhouse');
  } finally { page.close(); }
});

test('owner: a property photo can be removed', async () => {
  const url = `https://x.supabase.co/storage/v1/object/public/property-photos/${OWNER.id}/p1-1.jpg`;
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [
    roleRoute('owner'),
    [when('GET', 'properties'), req => rows(req, [{ id: 'p1', name: 'Villa', city: 'Kochi', lat: 9.9, lng: 76.2, photo_url: url }])],
  ] });
  try {
    await page.w.app.properties.load();
    assert.match(page.doc.getElementById('propGrid').textContent, /Remove photo/);
    page.backend.calls.length = 0;
    await page.w.app.properties.removePhoto('p1');
    const patch = page.backend.calls.find(c => c.method === 'PATCH' && c.table === 'properties');
    assert.equal(patch.body.photo_url, null);
    const del = page.backend.calls.find(c => c.method === 'DELETE' && c.table.includes('/storage/v1/object/property-photos'));
    assert.ok(del, 'stored file deleted');
    assert.deepEqual(del.body && JSON.parse(typeof del.body === 'string' ? del.body : JSON.stringify(del.body)).prefixes, [`${OWNER.id}/p1-1.jpg`]);
  } finally { page.close(); }
});

test('owner: booking price comes from the server quote (provider price + commission)', async () => {
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [
    roleRoute('owner'),
    [when('POST', 'rpc:quote_booking'), () => ({ body: { provider_paise: 200000, commission_paise: 20000, total_paise: 220000, commission_percent: 10, listed: true } })],
  ] });
  try {
    const doc = page.doc;
    doc.getElementById('bookPropSelect').innerHTML = '<option value="p1">Villa</option>';
    doc.getElementById('bookProvider').innerHTML = `<option value="${PROVIDER.id}">Prakash</option>`;
    page.w.app.servicesByProvider = { [PROVIDER.id]: [{ service_type: 'Deep Cleaning', price_paise: 200000 }] };
    page.w.app.populateServices();
    assert.equal(doc.getElementById('bookService').value, 'Deep Cleaning');
    await page.w.app.updatePricePreview();
    assert.match(doc.getElementById('pricePreview').textContent, /Total ₹2,200 — provider ₹2,000 \+ platform fee ₹200/);
    doc.getElementById('bookDate').value = page.w.dateInputValueInKerala(1);
    doc.getElementById('bookTime').value = '10:00';
    await page.w.app.bookings.saveBooking();
    assert.equal(page.w.app.pendingBookingData.amount, 220000);
    assert.equal(doc.getElementById('payAmountLabel').textContent, '₹2,200');
  } finally { page.close(); }
});

test('owner: only providers with listed services appear, and only their services can be picked', async () => {
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const page = await loadPage('owner-app.html', { user: OWNER, scripts: ownerScripts, routes: [
    roleRoute('owner'),
    [when('GET', 'platform_settings'), req => rows(req, [{ value: 10 }])],
    [when('GET', 'provider_services'), req => rows(req, [
      { provider_id: PROVIDER.id, service_type: 'Deep Cleaning', price_paise: 200000 },
      { provider_id: PROVIDER.id, service_type: 'Water Tank Cleaning', price_paise: 80000 }])],
    [when('GET', 'profiles', r => r.params.role === 'eq.provider'), req => rows(req, [
      { id: PROVIDER.id, first_name: 'Prakash', last_name: 'K' }, { id: OTHER, first_name: 'NoServices', last_name: 'Ltd' }])],
    [when('GET', 'properties'), req => rows(req, [{ id: 'p1', name: 'Villa', city: 'Kochi' }])],
  ] });
  try {
    const doc = page.doc;
    page.w.app.openBookingModal();
    await page.settle();
    const provs = [...doc.getElementById('bookProvider').options].map(o => o.textContent);
    assert.ok(provs.some(t => t.includes('Prakash')));
    assert.ok(!provs.some(t => t.includes('NoServices')), 'providers without services are hidden');
    assert.equal(doc.getElementById('bookService').disabled, true, 'no services until a provider is chosen');
    const sel = doc.getElementById('bookProvider');
    sel.value = PROVIDER.id; sel.onchange();
    const services = [...doc.getElementById('bookService').options].map(o => o.textContent);
    assert.deepEqual(services, ['Deep Cleaning — ₹2,200', 'Water Tank Cleaning — ₹880']);
  } finally { page.close(); }
});

test('maps use tiles that need no API key', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  for (const f of ['js/owner-app.js', 'js/owner-properties.js', 'js/owner-reports.js', 'js/owner-dashboard.js']) {
    const src = fs.readFileSync(path.join(require('./harness').ROOT, f), 'utf8');
    assert.ok(!src.includes('basemaps.cartocdn.com'), `${f} still uses CARTO tiles (now require an API key)`);
  }
});

// ── QA ────────────────────────────────────────────────────────────
test('QA: "Start Inspection" works for a property name with an apostrophe and escapes names', async () => {
  const assignment = { id: 'qa-1', status: 'assigned', trigger_type: 'random', booking_id: BOOKING, owner_id: OWNER.id, due_by: null,
    bookings: { service_type: 'General Cleaning', properties: { id: PROP, name: "Mary's Villa " + XSS, city: 'Kochi', lat: 9.93, lng: 76.26, geofence_radius: 200 } } };
  const page = await loadPage('qa-dashboard.html', { user: QA, scripts: ['js/supabase-config.js', 'js/shared-auth.js', 'js/qa-dashboard.js'], routes: [
    roleRoute('qa_inspector'),
    [when('GET', 'qa_assignments'), req => rows(req, [assignment])],
    [when('GET', 'profiles'), req => rows(req, [{ first_name: 'Quinn', last_name: '' }])],
  ] });
  try {
    assert.equal(page.doc.querySelector('#assignmentsGrid img'), null, 'property name not rendered as HTML');
    const btn = [...page.doc.querySelectorAll('#assignmentsGrid button')].find(b => b.textContent.includes('Start Inspection'));
    assert.ok(btn);
    btn.click();
    await page.settle();
    assert.deepEqual(page.errors.map(String), []);
    assert.equal(page.doc.getElementById('inspModal').style.display, 'flex', 'inspection modal opens');
    assert.equal(page.w.eval('activeBookingId'), BOOKING);
  } finally { page.close(); }
});

// ── Admin ─────────────────────────────────────────────────────────
test('admin: bookings, QA and alerts load with person names', async () => {
  // PostgREST rejects embeds through FKs that point at auth.users, like the live schema's.
  const embedErr = { status: 400, body: { code: 'PGRST200', message: "Could not find a relationship between 'bookings' and 'profiles'" } };
  const page = await loadPage('admin-dashboard.html', { user: ADMIN, scripts: ['js/supabase-config.js', 'js/shared-auth.js', 'js/admin-dashboard.js'], routes: [
    roleRoute('admin'),
    [when('POST', 'rpc:is_admin'), () => ({ body: true })],
    [req => req.method === 'GET' && (req.params.select || '').includes('profiles!'), () => embedErr],
    [when('GET', 'profiles'), req => rows(req, [
      { id: ADMIN.id, first_name: 'Ada', role: 'admin', created_at: '2026-01-01' },
      { id: PROVIDER.id, first_name: 'Prakash', last_name: 'K', role: 'provider', created_at: '2026-01-02' },
      { id: QA.id, first_name: 'Quinn', role: 'qa_inspector', created_at: '2026-01-03' },
      { id: OWNER.id, first_name: "O'Brien", role: 'owner', created_at: '2026-01-04' }])],
    [when('GET', 'bookings'), req => rows(req, [{ id: BOOKING, provider_id: PROVIDER.id, service_type: 'Deep Cleaning', status: 'confirmed', scheduled_date: '2099-01-01', properties: { name: 'Villa', city: 'Kochi' } }])],
    [when('GET', 'qa_assignments'), req => rows(req, [{ id: 'q1', inspector_id: QA.id, status: 'assigned', trigger_type: 'random', bookings: { properties: { name: 'Villa' } } }])],
    [when('GET', 'alerts'), req => rows(req, [{ id: 'a1', owner_id: OWNER.id, title: 'Hi', type: 'info', created_at: '2026-01-05' }])],
  ] });
  try {
    await page.settle();
    assert.match(page.doc.getElementById('bookingsTbody').textContent, /Prakash K/);
    assert.match(page.doc.getElementById('adminStats').textContent, /Held until completion[\s\S]*Commission earned/);
    assert.match(page.doc.getElementById('qaTbody').textContent, /Quinn/);
    assert.match(page.doc.getElementById('alertsTbody').textContent, /O'Brien/);
    // The Delete button for a name with an apostrophe must be a valid handler.
    const del = [...page.doc.querySelectorAll('#usersTbody button')].find(b => b.closest('tr').textContent.includes("O'Brien"));
    assert.doesNotThrow(() => new page.w.Function(del.getAttribute('onclick')));
  } finally { page.close(); }
});
