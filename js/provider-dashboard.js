// ── provider-dashboard.js ─────────────────────────────────────────
let currentUser = null;
let myJobs = [];
let myWorkers = [];
let activeJobId = null;
let pendingW = [];          // workers staged for assignment modal

// Service pricing map (in rupees)
const SERVICE_PRICES = {
    'General Cleaning': 1500, 'Deep Cleaning': 3500, 'Plumbing Check': 1200,
    'Electrical Check': 1200, 'Garden Maintenance': 2000, 'Pest Control': 2500,
    'Monsoon Prep': 3000, 'Security Check': 1000, 'Full Inspection': 5000
};

// Photo-stamp check-in state
let pendingPhotoFile = null;
let pendingCIArgs = null;   // { bookingId, pLat, pLng, radius }

// ════════════════════════════════════════════════════════════════
async function init() {
    currentUser = await initAuth();
    if (!currentUser) return;
    await Promise.all([loadJobs(), loadMyWorkers(), loadMyProfile()]);
    renderStats();
    renderUpcoming();
    renderJobs();
    renderWorkers();
    switchTab('dashboard');
}

// ════════════════════════════════════════════════════════════════
//  TAB SWITCHING
// ════════════════════════════════════════════════════════════════
function switchTab(tab) {
    ['dashboard', 'jobs', 'workers'].forEach(t => {
        document.getElementById('tab-' + t)?.classList.toggle('active', t === tab);
        document.getElementById('nav-' + t)?.classList.toggle('active', t === tab);
    });
    const titles = {
        dashboard: ['Provider <em>Dashboard</em>', 'Overview of your assigned jobs and team'],
        jobs: ['My <em>Jobs</em>', 'All service visits assigned to you'],
        workers: ['My <em>Workers</em>', 'Manage your field team']
    };
    document.getElementById('pageTitle').innerHTML = titles[tab][0];
    document.getElementById('pageSubtitle').textContent = titles[tab][1];
}

// ════════════════════════════════════════════════════════════════
//  DATA LOADING
// ════════════════════════════════════════════════════════════════
async function loadMyProfile() {
    try {
        const { data, error } = await db.from('profiles').select('*').eq('id', currentUser.id).single();
        if (error || !data) return;
        
        document.getElementById('myName').textContent = `${data.first_name || ''} ${data.last_name || ''}`;
        document.getElementById('myLocation').textContent = `📍 ${data.city || 'Anywhere'}`;
        document.getElementById('myRating').textContent = `⭐ ${data.rating || '5.0'} Rating`;
        document.getElementById('myBio').textContent = data.bio || 'Add a bio to let owners know about your expertise!';
        document.getElementById('myJobs').textContent = data.completed_jobs || 0;
        document.getElementById('myExp').textContent = data.experience_years || 0;
        // Show the provider's own photo/logo; otherwise keep the page's generic avatar.
        myProfile = data;
        const avatar = document.getElementById('myAvatar');
        avatar.src = data.avatar_url || DEFAULT_AVATAR;
        avatar.style.display = 'block';
        renderAvatarActions();
    } catch (e) {
        console.error('Error loading profile:', e);
    }
}

// ════════════════════════════════════════════════════════════════
//  SERVICES & PRICES (owners pay price + platform commission)
// ════════════════════════════════════════════════════════════════
let myServices = [];
let commissionPercent = 10;
let editingServiceId = null;

async function loadServices() {
    const [{ data: setting }, { data, error }] = await Promise.all([
        db.from('platform_settings').select('value').eq('key', 'commission_percent').maybeSingle(),
        db.from('provider_services').select('*').eq('provider_id', currentUser.id).order('service_type')
    ]);
    if (setting?.value != null) commissionPercent = Number(setting.value);
    const note = document.getElementById('commissionNote');
    if (note) note.textContent = `Owners pay your price plus a ${commissionPercent}% Tender Touch platform commission. You receive your full price when the job is completed and verified.`;
    const el = document.getElementById('servicesList');
    if (!el) return;
    if (error) { el.innerHTML = `<div style="color:var(--error);font-size:13px;">Could not load services: ${esc(error.message)}</div>`; return; }
    myServices = data || [];
    if (!myServices.length) {
        el.innerHTML = `<div style="color:#b45309;background:#fffbeb;border-radius:8px;padding:10px 12px;font-size:13px;">No services listed yet. Owners can only book services you list, so add at least one to start receiving bookings.</div>`;
        return;
    }
    el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;">
            <th style="padding:6px 4px;">Service</th><th style="padding:6px 4px;">You receive</th>
            <th style="padding:6px 4px;">Owner pays</th><th></th></tr></thead>
        <tbody>${myServices.map(s => {
            const q = commissionSplit(s.price_paise);
            return `<tr style="border-top:1px solid var(--border);">
                <td style="padding:10px 4px;"><strong>${esc(s.service_type)}</strong>${s.description ? `<div style="font-size:11px;color:var(--muted);">${esc(s.description)}</div>` : ''}</td>
                <td style="padding:10px 4px;">${rupees(q.provider)}</td>
                <td style="padding:10px 4px;">${rupees(q.total)} <span style="font-size:11px;color:var(--muted);">(incl. ${rupees(q.commission)} commission)</span></td>
                <td style="padding:10px 4px;text-align:right;white-space:nowrap;">
                    <button class="btn-ghost" style="font-size:11px;padding:3px 10px;" onclick="openServiceModal('${esc(s.id)}')">Edit</button>
                    <button class="btn-ghost" style="font-size:11px;padding:3px 10px;color:var(--error);" onclick="removeService('${esc(s.id)}')">Remove</button>
                </td></tr>`;
        }).join('')}</tbody></table>`;
}

function rupees(paise) { return '₹' + Math.round(paise / 100).toLocaleString('en-IN'); }

// Same rounding as public.quote_booking().
function commissionSplit(pricePaise) {
    const commission = Math.round(pricePaise * commissionPercent / 100);
    return { provider: pricePaise, commission, total: pricePaise + commission };
}

function openServiceModal(id = null) {
    editingServiceId = id;
    const existing = myServices.find(s => s.id === id);
    const sel = document.getElementById('svcType');
    const taken = new Set(myServices.filter(s => s.id !== id).map(s => s.service_type));
    const isCustom = existing && !SERVICE_PRICES[existing.service_type];
    sel.innerHTML = Object.keys(SERVICE_PRICES).map(t =>
        `<option value="${esc(t)}" ${taken.has(t) ? 'disabled' : ''}>${esc(t)}${taken.has(t) ? ' (already listed)' : ` (typical ₹${SERVICE_PRICES[t].toLocaleString('en-IN')})`}</option>`).join('')
        + (isCustom ? `<option value="${esc(existing.service_type)}">${esc(existing.service_type)}</option>` : '')
        + `<option value="__other">Other… (name your own service)</option>`;
    sel.value = existing?.service_type || Object.keys(SERVICE_PRICES).find(t => !taken.has(t)) || '__other';
    sel.disabled = !!existing;
    document.getElementById('svcCustom').value = '';
    toggleCustomService();
    document.getElementById('svcPrice').value = existing ? existing.price_paise / 100 : '';
    document.getElementById('svcDesc').value = existing?.description || '';
    document.getElementById('serviceModalTitle').textContent = existing ? 'Edit Price' : 'Add Service';
    updateCommissionPreview();
    document.getElementById('serviceModal').style.display = 'flex';
}

function toggleCustomService() {
    const other = document.getElementById('svcType').value === '__other';
    const input = document.getElementById('svcCustom');
    input.style.display = other ? 'block' : 'none';
    if (other && document.getElementById('serviceModal').style.display === 'flex') input.focus();
}

function closeServiceModal() {
    document.getElementById('serviceModal').style.display = 'none';
    editingServiceId = null;
}

// Live notice of the platform commission while the provider types a price.
function updateCommissionPreview() {
    const el = document.getElementById('commissionPreview');
    const price = Number(document.getElementById('svcPrice').value);
    if (!price || price < 100) {
        el.innerHTML = `<strong>Tender Touch adds a ${commissionPercent}% platform commission</strong> on top of your price. Enter a price (minimum ₹100) to see what owners pay.`;
        return;
    }
    const q = commissionSplit(Math.round(price * 100));
    el.innerHTML = `<strong>⚠️ Platform commission: ${commissionPercent}%</strong><br>
        You receive: <strong>${rupees(q.provider)}</strong><br>
        Tender Touch commission (${commissionPercent}%): <strong>${rupees(q.commission)}</strong><br>
        Owner pays: <strong>${rupees(q.total)}</strong><br>
        <span style="font-size:11px;">The owner's payment is held by Tender Touch and released to you only after the job is completed and verified.</span>`;
}

async function saveService() {
    let type = document.getElementById('svcType').value;
    if (type === '__other') {
        type = document.getElementById('svcCustom').value.trim().replace(/\s+/g, ' ');
        if (type.length < 2) { toast('Enter a name for your service (at least 2 characters).', 'error'); return; }
        if (myServices.some(s => s.id !== editingServiceId && s.service_type.toLowerCase() === type.toLowerCase())) {
            toast('You already list this service. Edit it instead.', 'error'); return;
        }
    }
    const price = Number(document.getElementById('svcPrice').value);
    const description = document.getElementById('svcDesc').value.trim() || null;
    if (!type) { toast('Choose a service.', 'error'); return; }
    if (!Number.isFinite(price) || price < 100 || price > 100000) { toast('Enter a price between ₹100 and ₹1,00,000.', 'error'); return; }
    const q = commissionSplit(Math.round(price * 100));
    const ok = await confirmDialog(
        `Save ${type} at ${rupees(q.provider)}?\n\n` +
        `Tender Touch adds a ${commissionPercent}% platform commission (${rupees(q.commission)}), so owners will pay ${rupees(q.total)}.\n` +
        `You receive ${rupees(q.provider)} after each completed, verified job.`,
        { okLabel: 'I understand, save' });
    if (!ok) return;
    const row = { provider_id: currentUser.id, service_type: type, price_paise: Math.round(price * 100), description, updated_at: new Date().toISOString() };
    const { error } = editingServiceId
        ? await db.from('provider_services').update(row).eq('id', editingServiceId).eq('provider_id', currentUser.id)
        : await db.from('provider_services').insert(row);
    if (error) {
        toast(error.code === '23505' ? 'You already list this service. Edit it instead.' : 'Could not save: ' + error.message, 'error');
        return;
    }
    toast(`${type} saved ✓`, 'success');
    closeServiceModal();
    await loadServices();
}

async function removeService(id) {
    const s = myServices.find(x => x.id === id);
    if (!s) return;
    if (!await confirmDialog(`Stop offering ${s.service_type}? Owners will no longer be able to book it. Existing bookings keep their price.`, { okLabel: 'Remove', danger: true })) return;
    const { error } = await db.from('provider_services').delete().eq('id', id).eq('provider_id', currentUser.id);
    if (error) { toast('Could not remove: ' + error.message, 'error'); return; }
    toast('Service removed.', 'success');
    await loadServices();
}

// ════════════════════════════════════════════════════════════════
//  PROFILE PHOTO / LOGO
// ════════════════════════════════════════════════════════════════
const DEFAULT_AVATAR = 'https://ui-avatars.com/api/?name=Provider&background=random';
let myProfile = null;

function renderAvatarActions() {
    const el = document.getElementById('avatarActions');
    if (!el) return;
    const has = !!myProfile?.avatar_url;
    el.innerHTML = `<button class="btn-ghost" style="font-size:11px;padding:3px 10px;" onclick="pickAvatar()">📷 ${has ? 'Change photo' : 'Add photo'}</button>`
        + (has ? `<button class="btn-ghost" style="font-size:11px;padding:3px 10px;color:var(--error);" onclick="removeAvatar()">Remove photo</button>` : '');
}

function pickAvatar() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => { if (input.files?.[0]) uploadAvatar(input.files[0]); };
    input.click();
}

// Path of a file in the provider-portfolios bucket, from its public URL (or null).
function portfolioPathFromUrl(url) {
    const marker = '/provider-portfolios/';
    const at = (url || '').indexOf(marker);
    return at === -1 ? null : decodeURIComponent(url.slice(at + marker.length).split('?')[0]);
}

async function deleteOldAvatarFile(url) {
    const path = portfolioPathFromUrl(url);
    if (!path || !path.startsWith(currentUser.id + '/')) return;
    const { error } = await db.storage.from('provider-portfolios').remove([path]);
    if (error) console.warn('Old photo file was not deleted:', error.message);
}

async function uploadAvatar(file) {
    if (!file.type.startsWith('image/')) { toast('Please choose an image file.', 'error'); return false; }
    if (file.size > 5 * 1024 * 1024) { toast('Photo is too large (max 5 MB).', 'error'); return false; }
    toast('Uploading photo…', 'success');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    // Stored in the provider's own folder; storage rules allow writes only there.
    const path = `${currentUser.id}/avatar-${Date.now()}.${ext}`;
    const { error: upErr } = await db.storage.from('provider-portfolios').upload(path, file, { contentType: file.type });
    if (upErr) { toast('Photo upload failed: ' + upErr.message, 'error'); return false; }
    const { data: pub } = db.storage.from('provider-portfolios').getPublicUrl(path);
    const previous = myProfile?.avatar_url;
    const { error } = await db.from('profiles').update({ avatar_url: pub.publicUrl }).eq('id', currentUser.id);
    if (error) { toast('Could not save the photo: ' + error.message, 'error'); return false; }
    if (previous) await deleteOldAvatarFile(previous);
    toast('Profile photo saved ✓', 'success');
    await loadMyProfile();
    return true;
}

async function removeAvatar() {
    if (!myProfile?.avatar_url) return;
    if (!await confirmDialog('Remove your profile photo? Owners will see the default picture instead.', { okLabel: 'Remove photo', danger: true })) return;
    const previous = myProfile.avatar_url;
    const { error } = await db.from('profiles').update({ avatar_url: null }).eq('id', currentUser.id);
    if (error) { toast('Could not remove the photo: ' + error.message, 'error'); return; }
    await deleteOldAvatarFile(previous);
    toast('Profile photo removed ✓', 'success');
    await loadMyProfile();
}

async function loadJobs() {
    // Step 1: bookings assigned to this provider
    const { data: bookings, error } = await db
        .from('bookings')
        .select('*, properties(id,name,address,city,state,lat,lng,geofence_radius)')
        .eq('provider_id', currentUser.id)
        .order('scheduled_date');

    if (error || !bookings) { myJobs = []; return; }

    // Step 2: owner profiles (separate query to avoid FK join errors)
    const ownerIds = [...new Set(bookings.map(b => b.owner_id).filter(Boolean))];
    let ownerMap = {};
    if (ownerIds.length) {
        const { data: owners } = await db.from('profiles').select('id,first_name,last_name,phone').in('id', ownerIds);
        (owners || []).forEach(o => { ownerMap[o.id] = o; });
    }

    // Step 3: visit reports for these bookings
    const bIds = bookings.map(b => b.id);
    let reportMap = {};
    if (bIds.length) {
        const { data: reports } = await db.from('visit_reports')
            .select('booking_id,checked_in_at,checked_out_at,inside_geofence,check_in_photo_url,notes')
            .in('booking_id', bIds).eq('provider_id', currentUser.id);
        (reports || []).forEach(r => { reportMap[r.booking_id] = r; });
    }

    // Step 4: worker assignments for these bookings
    let jwMap = {};
    if (bIds.length) {
        const { data: jw } = await db.from('job_workers')
            .select('id,booking_id,worker_id,provider_workers(first_name,last_name)')
            .in('booking_id', bIds);
        const { data: linkTokens } = await db.from('worker_checkin_tokens')
            .select('job_worker_id,token').eq('provider_id', currentUser.id);
        const tokenByAssignment = Object.fromEntries((linkTokens || []).map(t => [t.job_worker_id, t.token]));
        (jw || []).forEach(j => {
            if (!jwMap[j.booking_id]) jwMap[j.booking_id] = [];
            jwMap[j.booking_id].push({ ...j, checkin_token: tokenByAssignment[j.id] || null });
        });
    }

    // Step 5: worker check-ins (so the provider sees who is on site) and payments
    // (so earnings reflect money actually released, not a price list).
    let ciMap = {}, payMap = {};
    if (bIds.length) {
        const [{ data: cis }, { data: pays }] = await Promise.all([
            db.from('worker_checkins').select('booking_id,worker_id,check_in_time,check_out_time,inside_geofence').in('booking_id', bIds),
            db.from('payments').select('booking_id,amount,provider_amount,commission_amount,status').in('booking_id', bIds)
        ]);
        (cis || []).forEach(c => { ciMap[c.booking_id + ':' + c.worker_id] = c; });
        (pays || []).forEach(p => { payMap[p.booking_id] = p; });
    }

    myJobs = bookings.map(b => ({
        ...b,
        owner: ownerMap[b.owner_id] || null,
        report: reportMap[b.id] || null,
        payment: payMap[b.id] || null,
        workers: (jwMap[b.id] || []).map(w => ({ ...w, checkin: ciMap[b.id + ':' + w.worker_id] || null }))
    }));
}

async function loadMyWorkers() {
    const { data } = await db.from('provider_workers')
        .select('*')
        .eq('provider_id', currentUser.id)
        .order('first_name');
    myWorkers = data || [];
}

// ════════════════════════════════════════════════════════════════
//  STATS
// ════════════════════════════════════════════════════════════════
// Must match min_minutes in database/visit_evidence.sql.
const MIN_VISIT_MINUTES = 15;

// What the provider receives for the job (their price, without the platform commission).
function jobFee(j) {
    const paise = j.payment?.provider_amount ?? j.provider_amount ?? j.payment?.amount ?? j.amount;
    return paise != null ? Math.round(paise / 100) : (SERVICE_PRICES[j.service_type] || 0);
}

function paymentLabel(status) {
    return { paid: 'Held by Tender Touch until completion', released: 'Paid out to you', refunded: 'Refunded to owner', unpaid: 'Awaiting owner payment' }[status] || status;
}

function workerStatusBadge(ci) {
    // Time in Kerala; prefix the date when it was not today.
    const t = iso => {
        const d = new Date(iso);
        const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
        return day === todayDateInputValue() ? time
            : `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}, ${time}`;
    };
    if (!ci) return `<span class="wst so">Not checked in</span>`;
    if (ci.check_out_time) return `<span class="wst so">Left ${esc(t(ci.check_out_time))}</span>`;
    if (ci.inside_geofence) return `<span class="wst si">✅ On site since ${esc(t(ci.check_in_time))}</span>`;
    return `<span class="wst" style="background:rgba(220,38,38,.08);color:var(--error);">⚠️ Outside fence · ${esc(t(ci.check_in_time))}</span>`;
}

function renderStats() {
    const total = myJobs.length;
    const checkedIn = myJobs.filter(j => j.report?.checked_in_at && !j.report?.checked_out_at).length;
    const done = myJobs.filter(j => j.status === 'completed').length;
    // Earned = payments released to this provider (amounts are stored in paise).
    const earned = myJobs.reduce((sum, j) => sum + (j.payment?.status === 'released'
        ? (j.payment.provider_amount ?? j.payment.amount ?? 0) / 100 : 0), 0);
    document.getElementById('s-total').textContent = total;
    document.getElementById('s-in').textContent = checkedIn;
    document.getElementById('s-done').textContent = done;
    document.getElementById('s-wk').textContent = myWorkers.length;
    const earnEl = document.getElementById('s-earned');
    if (earnEl) earnEl.textContent = `₹${earned.toLocaleString('en-IN')}`;
}

// ════════════════════════════════════════════════════════════════
//  UPCOMING TABLE (Dashboard tab)
// ════════════════════════════════════════════════════════════════
function renderUpcoming() {
    const tbody = document.getElementById('upTbody');
    const today = todayDateInputValue();
    const list = myJobs.filter(j => !['completed', 'cancelled'].includes(j.status) && j.scheduled_date >= today).slice(0, 5);

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted);font-size:13px;">No upcoming jobs.</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(j => {
        const r = j.report;
        const ci = r?.checked_in_at
            ? `<span style="font-size:11px;font-weight:500;padding:3px 9px;border-radius:12px;${r.inside_geofence ? 'background:rgba(45,90,61,.1);color:var(--sage)' : 'background:rgba(220,38,38,.08);color:var(--error)'}">
                ${r.inside_geofence ? '✅ In' : '❌ Out'}${r.check_in_photo_url ? ' 📸' : ''}</span>`
            : `<span style="font-size:11px;color:var(--muted);">Pending</span>`;
        const ow = j.owner ? `${j.owner.first_name || ''} ${j.owner.last_name || ''}`.trim() : '—';
        return `<tr>
            <td><strong>${esc(j.properties?.name || '—')}</strong></td>
            <td>${esc(j.service_type || '—')}</td>
            <td>${esc(ow)}</td>
            <td>${formatBookingDateTime(j.scheduled_date, j.scheduled_time)}</td>
            <td><span class="status-badge ${j.status}">${(j.status || '—').replace('_', ' ')}</span></td>
            <td>${ci}</td>
        </tr>`;
    }).join('');
}

// ════════════════════════════════════════════════════════════════
//  JOB CARDS (My Jobs tab)
// ════════════════════════════════════════════════════════════════
function renderJobs() {
    const el = document.getElementById('jobsList');
    if (!myJobs.length) {
        el.innerHTML = `<div style="text-align:center;padding:60px 0;color:var(--muted);">
            <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2" style="opacity:.4;margin-bottom:16px;" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <p style="font-size:15px;font-weight:500;">No jobs assigned yet</p>
            <p style="font-size:13px;margin-top:6px;">Ask a property owner to book a visit and assign you as the provider.</p>
        </div>`;
        return;
    }

    el.innerHTML = myJobs.map((j, idx) => jobCard(j, idx)).join('');
}

function jobCard(j, idx) {
    const r = j.report;
    const prop = j.properties || {};
    const ow = j.owner;
    const owName = ow ? `${ow.first_name || ''} ${ow.last_name || ''}`.trim() : 'Property Owner';
    const hasCi = !!r?.checked_in_at;
    const hasCo = !!r?.checked_out_at;
    const isComp = j.status === 'completed';

    // Geo status pill
    let gpill = '';
    if (hasCi) {
        gpill = r.inside_geofence
            ? `<span class="gpill in">✅ Inside geo-fence${r.check_in_photo_url ? ' · 📸 Photo' : ''}</span>`
            : `<span class="gpill out">❌ Outside geo-fence${r.check_in_photo_url ? ' · 📸 Photo' : ''}</span>`;
    } else {
        gpill = `<span class="gpill pend">⏳ Not checked in</span>`;
    }

    // Action buttons
    let actions = '';
    if (isComp) {
        actions = `<span style="font-size:12px;color:var(--muted);">Job completed</span>`;
    } else if (j.status === 'cancelled') {
        actions = `<span style="font-size:12px;color:var(--muted);">Cancelled by owner</span>`;
    } else if (j.status === 'pending') {
        actions = `<span style="font-size:12px;color:var(--muted);">Awaiting owner payment</span>`;
    } else if (hasCo) {
        actions = `<button class="btn-rp" onclick="openReport('${j.id}')">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Submit Report
        </button>`;
    } else if (hasCi) {
        actions = `
            ${gpill}
            <button class="btn-co" onclick="doCheckOut('${j.id}')">
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                Check Out
            </button>`;
    } else if (j.scheduled_date > todayDateInputValue()) {
        actions = `${gpill}<span style="font-size:12px;color:var(--muted);">⏳ Check-in opens on ${esc(formatDate(j.scheduled_date))}</span>`;
    } else {
        const lat = prop.lat, lng = prop.lng, rad = prop.geofence_radius || 200;
        actions = `
            ${gpill}
            <button class="btn-ci" id="cb${idx}" onclick="doCheckIn('${j.id}',${lat || 'null'},${lng || 'null'},${rad})">
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                GPS Check-in
            </button>`;
    }

    // Workers section
    let workerSec = '';
    if (j.workers?.length) {
        const wrows = j.workers.map(w => {
            const pw = w.provider_workers || {};
            const baseUrl = window.location.origin + window.location.pathname.replace('provider-dashboard.html', '');
            const link = w.checkin_token ? `${baseUrl}worker-checkin.html?t=${encodeURIComponent(w.checkin_token)}&b=${j.id}` : null;
            return `<div class="w-row">
                <div class="wav">${(pw.first_name || '?')[0].toUpperCase()}</div>
                <div style="flex:1;font-size:13px;">
                    ${esc(pw.first_name || '')} ${esc(pw.last_name || '')}
                    <div style="font-size:10px;color:var(--muted);margin-top:2px;${link ? 'cursor:pointer;' : ''}" ${link ? `onclick="copyLink('${link}', this)"` : ''}>${link ? '🔗 Copy Check-in Link' : 'Check-in link unavailable'}</div>
                </div>
                ${workerStatusBadge(w.checkin)}
            </div>`;
        }).join('');
        workerSec = `<div class="w-sec">
            <div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:8px;">Assigned Workers (${j.workers.length})</div>
            ${wrows}
        </div>`;
    }

    // Notes
    const noteSec = j.notes ? `<div class="jc-note">📋 Owner note: ${esc(j.notes)}</div>` : '';

    return `<div class="job-card ${hasCi && !hasCo ? 'j-in' : hasCo ? 'j-out' : isComp ? 'j-done' : ''}">
        <div class="jc-head">
            <div class="jc-icon"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>
            <div style="flex:1;min-width:0;">
                <div class="jc-title">${esc(prop.name || '—')}</div>
                <div class="jc-sub">${esc(prop.address || '')}${prop.city ? ', ' + esc(prop.city) : ''}</div>
            </div>
            <span class="status-badge ${j.status}">${(j.status || '').replace('_', ' ')}</span>
        </div>
        <div class="jc-meta">
            <div class="jc-mr"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg><span><strong>${esc(j.service_type || 'Service')}</strong></span></div>
            <div class="jc-mr"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg><span><strong>${formatBookingDateTime(j.scheduled_date, j.scheduled_time)}</strong></span></div>
            <div class="jc-mr"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>Owner: <strong>${esc(owName)}</strong>${ow?.phone ? ` · ${esc(ow.phone)}` : ''}</span></div>
            <div class="jc-mr"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg><span>Geo-fence: <strong>${prop.geofence_radius || 200}m</strong></span></div>
            <div class="jc-mr"><svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg><span>You receive: <strong>₹${jobFee(j).toLocaleString('en-IN')}</strong>${j.payment ? ` · ${esc(paymentLabel(j.payment.status))}` : ''}</span></div>
        </div>
        ${noteSec}
        <div class="jc-foot">
            ${actions}
            ${!isComp && j.status !== 'cancelled' ? `<button class="btn-as" onclick="openAssign('${j.id}')">👷 Manage Workers</button>` : ''}
        </div>
        ${workerSec}
    </div>`;
}

// Notify the booking's owner. Supabase query builders have no .catch(), so
// errors are read from the result; a failed alert must not break the main flow.
async function notifyOwner(job, alert) {
    if (!job?.owner_id) return;
    const { error } = await db.from('alerts').insert({
        owner_id: job.owner_id,
        property_id: job.property_id || null,
        ...alert
    });
    if (error) console.warn('Owner alert could not be sent:', error.message);
}

// ════════════════════════════════════════════════════════════════
//  GPS CHECK-IN WITH PHOTO STAMP
// ════════════════════════════════════════════════════════════════
function doCheckIn(bookingId, pLat, pLng, radius) {
    const job = myJobs.find(j => j.id === bookingId);
    if (job && job.scheduled_date > todayDateInputValue()) {
        toast(`Check-in opens on ${formatDate(job.scheduled_date)}, the day of the visit.`, 'error');
        return;
    }
    if (!navigator.geolocation) { toast('GPS not supported on this device.', 'error'); return; }
    if (pLat == null || pLng == null || !Number.isFinite(Number(pLat)) || !Number.isFinite(Number(pLng))) {
        toast('This property has no map location yet. Ask the owner to add it before GPS check-in.', 'error');
        return;
    }
    pendingCIArgs = { bookingId, pLat, pLng, radius };
    pendingPhotoFile = null;
    document.getElementById('photoPreviewWrap').style.display = 'none';
    document.getElementById('photoBtnWrap').style.display = 'block';
    document.getElementById('photoConfirmBtn').disabled = true;
    document.getElementById('photoInput').value = '';
    document.getElementById('photoModal').style.display = 'flex';
}

function onPhotoChosen(input) {
    if (!input.files?.length) return;
    pendingPhotoFile = input.files[0];
    document.getElementById('photoPreview').src = URL.createObjectURL(pendingPhotoFile);
    document.getElementById('photoPreviewWrap').style.display = 'block';
    document.getElementById('photoBtnWrap').style.display = 'none';
    document.getElementById('photoConfirmBtn').disabled = false;
}

function retakePhoto() {
    pendingPhotoFile = null;
    document.getElementById('photoInput').value = '';
    document.getElementById('photoPreviewWrap').style.display = 'none';
    document.getElementById('photoBtnWrap').style.display = 'block';
    document.getElementById('photoConfirmBtn').disabled = true;
}

function cancelPhotoCI() {
    document.getElementById('photoModal').style.display = 'none';
    pendingCIArgs = null; pendingPhotoFile = null;
}

async function confirmPhotoCI() {
    if (!pendingPhotoFile || !pendingCIArgs) return;
    const btn = document.getElementById('photoConfirmBtn');
    btn.disabled = true; btn.textContent = '📍 Getting GPS…';

    const { bookingId, pLat, pLng, radius } = pendingCIArgs;
    const job = myJobs.find(j => j.id === bookingId);
    const propName = job?.properties?.name || 'Property';

    navigator.geolocation.getCurrentPosition(async pos => {
        const myLat = pos.coords.latitude, myLng = pos.coords.longitude;
        const inside = haversine(myLat, myLng, Number(pLat), Number(pLng)) <= Number(radius || 200);

        btn.textContent = '🖼️ Stamping & uploading photo…';
        // Pass GPS + fence status + property name so they get burned into the photo
        const photoUrl = await uploadCheckInPhoto(bookingId, pendingPhotoFile, myLat, myLng, inside, propName);

        const { data: saved, error } = await db.from('visit_reports').upsert({
            booking_id: bookingId,
            provider_id: currentUser.id,
            check_in_lat: myLat, check_in_lng: myLng,
            inside_geofence: inside,
            checked_in_at: new Date().toISOString(),
            check_in_photo_url: photoUrl || null
        }, { onConflict: 'booking_id,provider_id' }).select('inside_geofence').single();

        document.getElementById('photoModal').style.display = 'none';
        btn.disabled = false; btn.textContent = '✅ Check In with Photo';
        pendingCIArgs = null; pendingPhotoFile = null;

        if (error) { toast('Error: ' + error.message, 'error'); return; }

        // The database recomputes the geofence; trust its answer over the browser's.
        const insideFence = saved ? saved.inside_geofence === true : inside;
        if (job?.status === 'confirmed') {
            const { error: statusErr } = await db.from('bookings').update({ status: 'in_progress' })
                .eq('id', bookingId).eq('provider_id', currentUser.id);
            if (statusErr) console.warn('Could not mark job in progress:', statusErr.message);
        }

        toast(insideFence ? '✅ Checked in! Photo + GPS stamped & recorded.' : '⚠️ Checked in but OUTSIDE geo-fence. Owner alerted.', insideFence ? 'success' : 'error');

        await notifyOwner(job, {
            type: insideFence ? 'info' : 'warning',
            title: insideFence ? '✅ Provider Checked In' : '⚠️ Provider Outside Geo-fence',
            message: `${currentUser.user_metadata?.first_name || 'Your provider'} checked in at "${propName}" ${insideFence ? 'inside' : 'OUTSIDE'} the geo-fence.${photoUrl ? ' Stamped photo proof is available in Inspection Reports.' : ''}`
        });

        await Promise.all([loadJobs(), loadMyWorkers()]);
        renderStats(); renderUpcoming(); renderJobs(); renderWorkers();
    }, err => {
        document.getElementById('photoModal').style.display = 'none';
        btn.disabled = false; btn.textContent = '✅ Check In with Photo';
        toast('GPS error: ' + err.message, 'error');
        pendingCIArgs = null; pendingPhotoFile = null;
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

/**
 * Burn timestamp + GPS text onto a photo using Canvas.
 * Returns a new File with the stamped image.
 */
async function stampPhoto(file, lat, lng, label = '', inside = null) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            const now = new Date();
            const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            const gpsStr = lat && lng ? `GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'GPS: unavailable';
            const fenceStr = inside === true ? '✅ Inside Geo-fence' : inside === false ? '⚠️ Outside Geo-fence' : '';

            const lines = [
                `📍 ${label}`,
                `🕐 ${dateStr}  ${timeStr}`,
                gpsStr,
                fenceStr
            ].filter(Boolean);

            // Stamp dimensions
            const fontSize = Math.max(16, Math.round(canvas.width / 40));
            const padding = fontSize * 0.8;
            const lineH = fontSize * 1.5;
            const boxH = lines.length * lineH + padding * 2;
            const boxY = canvas.height - boxH - padding;

            // Dark semi-transparent background
            ctx.fillStyle = 'rgba(0, 0, 0, 0.60)';
            ctx.fillRect(0, boxY, canvas.width, boxH + padding);

            // Green left border
            ctx.fillStyle = inside === false ? '#f59e0b' : '#22c55e';
            ctx.fillRect(0, boxY, 6, boxH + padding);

            // Text
            ctx.font = `500 ${fontSize}px monospace`;
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 4;
            lines.forEach((line, i) => {
                ctx.fillText(line, padding + 10, boxY + padding + (i + 1) * lineH - 4);
            });

            // "TENDER TOUCH VERIFIED" watermark
            ctx.font = `bold ${Math.round(canvas.width / 25)}px 'DM Sans', sans-serif`;
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.shadowBlur = 0;
            ctx.save();
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate(-Math.PI / 6);
            ctx.textAlign = 'center';
            ctx.fillText('TENDER TOUCH VERIFIED', 0, 0);
            ctx.restore();

            canvas.toBlob(blob => {
                resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
            }, 'image/jpeg', 0.88);
        };
        img.onerror = () => resolve(file); // fallback: use original if canvas fails
        img.src = URL.createObjectURL(file);
    });
}

async function uploadCheckInPhoto(bookingId, file, lat = null, lng = null, inside = null, propName = '') {
    try {
        // Stamp the photo before uploading
        const stamped = await stampPhoto(file, lat, lng, `Check-in: ${propName}`, inside);
        const ext = 'jpg';
        const path = `provider/${currentUser.id}/${bookingId}_checkin_${Date.now()}.${ext}`;
        const { error } = await db.storage.from('visit-photos').upload(path, stamped, { contentType: 'image/jpeg', upsert: false });
        if (error) { console.warn('Upload failed:', error.message); return null; }
        const { data: pub } = db.storage.from('visit-photos').getPublicUrl(path);
        return pub?.publicUrl || null;
    } catch (e) { console.warn('Photo upload error:', e); return null; }
}


async function doCheckOut(bookingId) {
    const { error } = await db.from('visit_reports')
        .update({ checked_out_at: new Date().toISOString() })
        .eq('booking_id', bookingId).eq('provider_id', currentUser.id);
    if (error) { toast('Error: ' + error.message, 'error'); return; }
    toast('✅ Checked out.', 'success');
    await Promise.all([loadJobs(), loadMyWorkers()]);
    renderStats(); renderUpcoming(); renderJobs(); renderWorkers();
}

// Haversine distance in metres
function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ════════════════════════════════════════════════════════════════
//  WORK REPORT MODAL
// ════════════════════════════════════════════════════════════════
let beforePhotoFile = null;
let afterPhotoFile = null;

function previewPhoto(type, input) {
    if (!input.files?.length) return;
    const file = input.files[0];
    const thumb = document.getElementById(type + 'Thumb');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.style = 'width:100%;height:100%;object-fit:cover;';
    thumb.innerHTML = '';
    thumb.appendChild(img);
    if (type === 'before') beforePhotoFile = file;
    else afterPhotoFile = file;
}

function openReport(id) {
    activeJobId = id;
    // Reset
    document.getElementById('rNotes').value = '';
    document.getElementById('rCond').value = 'good';
    document.getElementById('beforeThumb').innerHTML = '<span>Click to take<br>before photo</span>';
    document.getElementById('afterThumb').innerHTML = '<span>Click to take<br>after photo</span>';
    document.getElementById('beforeInput').value = '';
    document.getElementById('afterInput').value = '';
    beforePhotoFile = null; afterPhotoFile = null;
    ['cl_clean', 'cl_garden', 'cl_plumb', 'cl_elec', 'cl_drain', 'cl_roof', 'cl_pest', 'cl_secur'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = false;
    });
    document.getElementById('reportModal').style.display = 'flex';
}
function closeReport() {
    document.getElementById('reportModal').style.display = 'none';
    activeJobId = null;
    beforePhotoFile = null; afterPhotoFile = null;
}
async function submitReport() {
    const btn = document.querySelector('#reportModal .btn-submit, #reportModal button[onclick="submitReport()"]');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    const fail = msg => { toast(msg, 'error'); if (btn) btn.disabled = false; };

    // The database only lets a job be completed with real visit evidence
    // (database/visit_evidence.sql); check the same rules here to explain early.
    const job = myJobs.find(j => j.id === activeJobId);
    const visit = job?.report;
    if (!afterPhotoFile) return fail('Add an after photo of the finished work.');
    if (!visit?.checked_in_at || !visit?.checked_out_at) return fail('Check in and check out at the property before submitting the report.');
    const onSite = visit.inside_geofence === true || (job.workers || []).some(w => w.checkin?.inside_geofence);
    if (!onSite) return fail('This visit was not recorded inside the property\'s geo-fence, so it can\'t be completed. Contact the property owner if you were there.');
    const minutes = (new Date(visit.checked_out_at) - new Date(visit.checked_in_at)) / 60000;
    if (minutes < MIN_VISIT_MINUTES) return fail(`A visit must last at least ${MIN_VISIT_MINUTES} minutes on site; yours lasted ${Math.floor(minutes)}.`);

    const notes = document.getElementById('rNotes').value.trim();
    const cond = document.getElementById('rCond').value;

    // Collect checklist
    const items = ['cl_clean', 'cl_garden', 'cl_plumb', 'cl_elec', 'cl_drain', 'cl_roof', 'cl_pest', 'cl_secur'];
    const labels = ['General Cleaning', 'Garden / Lawn', 'Plumbing Check', 'Electrical Check', 'Drain / Water Flow', 'Roof Inspection', 'Pest / Signs Check', 'Locks / Security'];
    const checklist = {};
    items.forEach((id, i) => { checklist[labels[i]] = document.getElementById(id)?.checked || false; });

    toast('Uploading photos…', 'success');

    // Upload photos
    let beforeUrl = null, afterUrl = null;
    if (beforePhotoFile) beforeUrl = await uploadVisitPhoto(activeJobId, 'before', beforePhotoFile);
    if (afterPhotoFile) afterUrl = await uploadVisitPhoto(activeJobId, 'after', afterPhotoFile);
    if (!afterUrl) return fail('The after photo could not be uploaded. Check your connection and try again.');

    const { error } = await db.from('visit_reports').upsert({
        booking_id: activeJobId,
        provider_id: currentUser.id,
        notes, condition: cond, checklist,
        before_photo_url: beforeUrl,
        after_photo_url: afterUrl,
        checked_out_at: new Date().toISOString()
    }, { onConflict: 'booking_id,provider_id' });

    if (error) { toast('Error: ' + error.message, 'error'); btn && (btn.disabled = false); return; }

    // Completing the booking also releases the payment (database trigger).
    const { error: completeErr } = await db.from('bookings').update({ status: 'completed' })
        .eq('id', activeJobId).eq('provider_id', currentUser.id);
    if (completeErr) {
        toast('Report saved, but the job could not be marked complete: ' + completeErr.message, 'error');
        btn && (btn.disabled = false);
        return;
    }

    const cond_emoji = { good: '✅', partial: '⚠️', issue: '❌' }[cond] || 'ℹ️';
    await notifyOwner(job, {
        type: cond === 'issue' ? 'warning' : 'info',
        title: `${cond_emoji} Work Report Submitted — ${job?.properties?.name || 'Your Property'}`,
        message: `${currentUser.user_metadata?.first_name || 'Your provider'} submitted a work report (${cond}). ${beforeUrl ? 'Before & after photos available in Inspection Reports.' : ''} ${notes ? 'Note: ' + notes.slice(0, 80) : ''}`.trim()
    });

    toast('✅ Report submitted! Owner notified.', 'success');
    if (btn) btn.disabled = false;
    closeReport();
    await Promise.all([loadJobs(), loadMyWorkers()]);
    renderStats(); renderUpcoming(); renderJobs(); renderWorkers();
}

async function uploadVisitPhoto(bookingId, type, file) {
    try {
        // Get current GPS position for the stamp
        let lat = null, lng = null;
        try {
            const pos = await new Promise((res, rej) =>
                navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
            );
            lat = pos.coords.latitude;
            lng = pos.coords.longitude;
        } catch (_) { /* GPS unavailable — stamp will show 'unavailable' */ }

        const label = type === 'before' ? '📷 Before Service' : '✅ After Service';
        const job = myJobs.find(j => j.id === bookingId);
        const propName = job?.properties?.name || '';
        const stampLabel = propName ? `${label} — ${propName}` : label;

        const stamped = await stampPhoto(file, lat, lng, stampLabel, null);
        const path = `${currentUser.id}/${bookingId}_${type}_${Date.now()}.jpg`;
        const { error } = await db.storage.from('visit-photos').upload(path, stamped, { contentType: 'image/jpeg' });
        if (error) { console.warn('Upload failed:', error.message); return null; }
        const { data } = db.storage.from('visit-photos').getPublicUrl(path);
        return data?.publicUrl || null;
    } catch (e) { console.warn('Photo upload error:', e); return null; }
}

// ════════════════════════════════════════════════════════════════
//  ASSIGN WORKERS MODAL
// ════════════════════════════════════════════════════════════════
function openAssign(bookingId) {
    activeJobId = bookingId;
    const job = myJobs.find(j => j.id === bookingId);
    pendingW = (job?.workers || []).map(jw => jw.worker_id);
    document.getElementById('wSearch').value = '';
    document.getElementById('wRes').innerHTML = '';
    renderChips();
    document.getElementById('assignModal').style.display = 'flex';
}
function closeAssign() {
    document.getElementById('assignModal').style.display = 'none';
    activeJobId = null; pendingW = [];
}
function searchW() {
    const q = document.getElementById('wSearch').value.toLowerCase();
    const results = myWorkers.filter(w =>
        (`${w.first_name} ${w.last_name}`).toLowerCase().includes(q) && !pendingW.includes(w.id)
    );
    document.getElementById('wRes').innerHTML = results.slice(0, 5).map(w => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;cursor:pointer;hover:background:var(--cream);" onclick="addChip('${w.id}')">
            <div class="wav">${(w.first_name || '?')[0].toUpperCase()}</div>
            <div style="flex:1;font-size:13px;">${esc(w.first_name)} ${esc(w.last_name || '')}</div>
            <button style="font-size:12px;background:var(--sage-pale);color:var(--sage);border:none;border-radius:8px;padding:4px 10px;cursor:pointer;">Add</button>
        </div>`).join('');
}
function addChip(wid) {
    if (!pendingW.includes(wid)) pendingW.push(wid);
    document.getElementById('wSearch').value = '';
    document.getElementById('wRes').innerHTML = '';
    renderChips();
}
function removeChip(wid) {
    pendingW = pendingW.filter(id => id !== wid);
    renderChips();
}
function renderChips() {
    const el = document.getElementById('assignChips');
    if (!pendingW.length) { el.innerHTML = '<span style="font-size:12px;color:var(--muted);">None yet</span>'; return; }
    el.innerHTML = pendingW.map(wid => {
        const w = myWorkers.find(x => x.id === wid);
        if (!w) return '';
        return `<div class="chip">${esc(w.first_name)} ${esc(w.last_name || '')}<button onclick="removeChip('${wid}')">×</button></div>`;
    }).join('');
}
async function saveAssign() {
    if (!activeJobId) return;
    // Change only what changed: deleting an assignment also deletes its secret
    // check-in link, so untouched workers must keep their existing rows.
    const job = myJobs.find(j => j.id === activeJobId);
    const current = (job?.workers || []).map(jw => jw.worker_id);
    const removed = current.filter(wid => !pendingW.includes(wid));
    const added = pendingW.filter(wid => !current.includes(wid));
    if (removed.length) {
        const { error } = await db.from('job_workers').delete()
            .eq('booking_id', activeJobId).in('worker_id', removed);
        if (error) { toast('Could not remove workers: ' + error.message, 'error'); return; }
    }
    if (added.length) {
        const { error } = await db.from('job_workers').insert(added.map(wid => ({
            booking_id: activeJobId,
            worker_id: wid,
            assigned_by: currentUser.id
        })));
        if (error) { toast('Could not assign workers: ' + error.message, 'error'); return; }
    }
    toast('Workers assigned ✓', 'success');
    closeAssign();
    await Promise.all([loadJobs(), loadMyWorkers()]);
    renderStats(); renderUpcoming(); renderJobs(); renderWorkers();
}

// ════════════════════════════════════════════════════════════════
//  ADD WORKER MODAL
// ════════════════════════════════════════════════════════════════
function openAddWorker() {
    ['awFirst', 'awLast', 'awPhone', 'awSpec'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('addWModal').style.display = 'flex';
}
function closeAddWorker() {
    document.getElementById('addWModal').style.display = 'none';
}
async function saveWorker() {
    const first = document.getElementById('awFirst').value.trim();
    const last = document.getElementById('awLast').value.trim();
    const phone = document.getElementById('awPhone').value.trim();
    const spec = document.getElementById('awSpec').value.trim();
    if (!first || !phone) { toast('First name and phone are required.', 'error'); return; }
    const { data, error } = await db.from('provider_workers').insert({
        provider_id: currentUser.id, first_name: first, last_name: last, phone, specialization: spec || null
    }).select().single();
    if (error) { toast('Error: ' + error.message, 'error'); return; }
    toast(`Worker ${first} added ✓`, 'success');
    closeAddWorker();
    await loadMyWorkers();
    renderStats();
    renderWorkers();
}

// ════════════════════════════════════════════════════════════════
//  MY WORKERS TAB
// ════════════════════════════════════════════════════════════════
function renderWorkers() {
    const el = document.getElementById('workersList');
    if (!myWorkers.length) {
        el.innerHTML = `<div style="text-align:center;padding:60px 0;color:var(--muted);">
            <p style="font-size:15px;font-weight:500;margin-bottom:8px;">No workers yet</p>
            <p style="font-size:13px;">Add workers to your team. They check in via a unique link — no account needed.</p>
        </div>`;
        return;
    }
    el.innerHTML = myWorkers.map(w => {
        const assignedJobsCount = myJobs.filter(j => j.workers?.some(jw => jw.worker_id === w.id)).length;
        const assignedJob = myJobs.find(j => j.status !== 'completed' && j.workers?.some(jw => jw.worker_id === w.id && jw.checkin_token));
        const assignment = assignedJob?.workers.find(jw => jw.worker_id === w.id && jw.checkin_token);
        const baseUrl = window.location.origin + window.location.pathname.replace('provider-dashboard.html', '');
        const link = assignment ? `${baseUrl}worker-checkin.html?t=${encodeURIComponent(assignment.checkin_token)}&b=${assignedJob.id}` : null;

        return `<div class="wcard">
            <div class="wcav">${(w.first_name || '?')[0].toUpperCase()}</div>
            <div style="flex:1;min-width:0;">
                <div style="font-weight:500;font-size:14px;">${esc(w.first_name)} ${esc(w.last_name || '')}</div>
                <div style="font-size:12px;color:var(--muted);">${esc(w.phone || '')}${w.specialization ? ' · ' + esc(w.specialization) : ''}</div>
                <div style="font-size:11px;color:var(--sage);margin-top:4px;">${assignedJobsCount} job${assignedJobsCount !== 1 ? 's' : ''} assigned</div>
            </div>
            <button title="Copy check-in link" ${link ? '' : 'disabled'} style="background:none;border:1px solid var(--border);border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;color:var(--muted);"
                ${link ? `onclick="copyLink('${link}', this)"` : ''}>🔗 ${link ? 'Job' : 'Assign a job first'}</button>
        </div>`;
    }).join('');
}

function copyLink(url, btn) {
    const orig = btn.textContent;
    const copied = () => {
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
    };
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(copied).catch(() => {
            window.prompt('Copy this check-in link:', url);
        });
    } else {
        window.prompt('Copy this check-in link:', url);
    }
}

// ════════════════════════════════════════════════════════════════
//  EDIT PROFILE
// ════════════════════════════════════════════════════════════════
async function openEditProfile() {
    const { data, error } = await db.from('profiles').select('*').eq('id', currentUser.id).single();
    if (error || !data) { toast('Failed to load profile', 'error'); return; }
    document.getElementById('epFirst').value = data.first_name || '';
    document.getElementById('epLast').value = data.last_name || '';
    document.getElementById('epCity').value = data.city || '';
    document.getElementById('epExp').value = data.experience_years || 0;
    document.getElementById('epPhone').value = data.phone || '';
    document.getElementById('epBio').value = data.bio || '';
    document.getElementById('editProfileModal').style.display = 'flex';
}

function closeEditProfile() {
    document.getElementById('editProfileModal').style.display = 'none';
}

async function saveProfile() {
    const first = document.getElementById('epFirst').value.trim();
    const last = document.getElementById('epLast').value.trim();
    const city = document.getElementById('epCity').value.trim();
    const exp = parseInt(document.getElementById('epExp').value) || 0;
    const phone = document.getElementById('epPhone').value.trim();
    const bio = document.getElementById('epBio').value.trim();

    if (!first) { toast('First name is required', 'error'); return; }

    const { error } = await db.from('profiles').update({
        first_name: first,
        last_name: last,
        city: city || null,
        experience_years: exp,
        phone: phone || null,
        bio: bio || null
    }).eq('id', currentUser.id);

    if (error) { toast('Failed to save: ' + error.message, 'error'); return; }

    toast('Profile updated successfully ✓', 'success');
    closeEditProfile();
    await loadMyProfile(); // Refresh profile card
}

// ════════════════════════════════════════════════════════════════
//  PORTFOLIO (RECENT WORK)
// ════════════════════════════════════════════════════════════════
async function loadPortfolio() {
    const grid = document.getElementById('portfolioGrid');
    if (!grid) return;
    grid.innerHTML = '<div style="color:#6b7280;font-size:13px;grid-column:1/-1;">Loading portfolio...</div>';

    const { data, error } = await db.from('provider_portfolio')
        .select('*')
        .eq('provider_id', currentUser.id)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error loading portfolio:', error);
        grid.innerHTML = '<div style="color:red;font-size:13px;grid-column:1/-1;">Failed to load portfolio.</div>';
        return;
    }

    if (!data || data.length === 0) {
        grid.innerHTML = '<div style="color:#6b7280;font-size:13px;grid-column:1/-1;padding:12px 0;">No work uploaded yet. Click "+ Add Work" to showcase your services.</div>';
        return;
    }

    grid.innerHTML = data.map(item => `
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;position:relative;group">
            <div style="height:120px;background:#e5e7eb;width:100%;">
                <img src="${esc(item.image_url)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.src='https://via.placeholder.com/400x300?text=Error'">
            </div>
            <div style="padding:10px 12px;display:flex;justify-content:space-between;align-items:center;">
                <div style="font-size:12px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(item.title)}">${esc(item.title)}</div>
                <button onclick="deletePortfolioItem('${item.id}')" style="background:none;border:none;color:var(--danger);cursor:pointer;padding:4px;display:flex;align-items:center;justify-content:center;" title="Delete">
                    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
                </button>
            </div>
        </div>
    `).join('');
}

function openPortfolioModal() {
    document.getElementById('portTitle').value = '';
    document.getElementById('portFile').value = '';
    document.getElementById('portfolioUploadModal').style.display = 'flex';
}

function closePortfolioModal() {
    document.getElementById('portfolioUploadModal').style.display = 'none';
}

async function uploadPortfolioItem() {
    const title = document.getElementById('portTitle').value.trim();
    const fileInput = document.getElementById('portFile');
    const file = fileInput.files[0];

    if (!title || !file) {
        toast('Please provide a title and select a photo.', 'error');
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        toast('File is too large (max 5MB).', 'error');
        return;
    }

    const btn = document.getElementById('portSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Uploading...';

    try {
        // 1. Upload to Storage
        const ext = file.name.split('.').pop();
        const fileName = `${currentUser.id}/${Date.now()}.${ext}`;
        
        const { error: uploadError } = await db.storage
            .from('provider-portfolios')
            .upload(fileName, file);

        if (uploadError) throw new Error('Photo upload failed: ' + uploadError.message);

        // 2. Get Public URL
        const { data: publicUrlData } = db.storage
            .from('provider-portfolios')
            .getPublicUrl(fileName);

        // 3. Save to DB
        const { error: dbError } = await db.from('provider_portfolio').insert({
            provider_id: currentUser.id,
            title: title,
            image_url: publicUrlData.publicUrl
        });

        if (dbError) throw new Error('Database save failed: ' + dbError.message);

        toast('Work added to portfolio!', 'success');
        closePortfolioModal();
        loadPortfolio();

    } catch (err) {
        console.error(err);
        toast(err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Upload';
    }
}

async function deletePortfolioItem(id) {
    if (!await confirmDialog('Delete this portfolio item?', { okLabel: 'Delete', danger: true })) return;
    
    // Deleting the record from DB. The file remains in storage unless cleaned up, 
    // but for simplicity we just remove the DB row for now.
    const { error } = await db.from('provider_portfolio').delete().eq('id', id);
    if (error) {
        toast('Failed to delete: ' + error.message, 'error');
    } else {
        toast('Item deleted.', 'success');
        loadPortfolio();
    }
}

// Override init to also load portfolio
const originalInit = init;
init = async function() {
    await originalInit();
    if (currentUser) {
        await loadServices();
        await loadPortfolio();
    }
}

init();
