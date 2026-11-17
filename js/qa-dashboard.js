// ── qa-dashboard.js ───────────────────────────────────────────────
let currentUser = null;
let currentProp = null;
let currentQAId = null;  // qa_assignment_id
let activeAssignmentId = null;
let activeBookingId = null;
let activeOwnerId = null;
let allInspections = [];
let finalVerdict = 'approved';

const chItems = [
    { id: 'roof', field: 'roof_verified', label: 'Roof & Exterior Walls' },
    { id: 'plumb', field: 'plumbing_verified', label: 'Plumbing & Water Systems' },
    { id: 'elec', field: 'electrical_verified', label: 'Electrical Panels & Outlets' },
    { id: 'clean', field: 'cleaning_verified', label: 'General Cleanliness' },
    { id: 'garden', field: 'garden_verified', label: 'Garden & Lawn Care' },
    { id: 'sec', field: 'security_verified', label: 'Security Cameras & Locks' }
];

function toast(msg, type = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = `toast show ${type}`;
    setTimeout(() => t.classList.remove('show'), 3000);
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function logout() { await db.auth.signOut(); window.location.href = 'login.html'; }

async function init() {
    currentUser = await initAuth(true);
    if (!currentUser) return;

    const d = new Date();
    const el = document.getElementById('currentDate');
    if (el) el.textContent = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const avatarEl = document.getElementById('sidebarAvatar');
    const nameEl = document.getElementById('sidebarName');
    const { data: prof } = await db.from('profiles').select('first_name,last_name').eq('id', currentUser.id).single();
    if (avatarEl && prof) avatarEl.textContent = (prof.first_name || '?')[0].toUpperCase();
    if (nameEl && prof) nameEl.textContent = `${prof.first_name || ''} ${prof.last_name || ''}`.trim();

    await loadAssignments();
}

async function loadAssignments() {
    const loadEl = document.getElementById('loading');
    if (loadEl) loadEl.style.display = 'block';

    // Use due_by (the actual column name in the schema)
    const { data: qa, error } = await db.from('qa_assignments')
        .select(`id, status, assigned_at, due_by, trigger_type, booking_id, owner_id,
            bookings!inner(service_type, scheduled_date, scheduled_time,
                properties(id, name, city, lat, lng, geofence_radius))`)
        .eq('inspector_id', currentUser.id)
        .order('assigned_at', { ascending: false });

    if (loadEl) loadEl.style.display = 'none';

    if (error) { toast('Error loading assignments: ' + error.message, 'error'); return; }

    allInspections = qa || [];
    updateStats();
    renderActiveAssignments();
    renderOverviewPending();
}

function updateStats() {
    const total = allInspections.length;
    const pending = allInspections.filter(q => q.status !== 'completed').length;
    const completed = allInspections.filter(q => q.status === 'completed').length;
    const today = todayDateInputValue();
    const dueToday = allInspections.filter(q =>
        q.status !== 'completed' && q.due_by && q.due_by.slice(0, 10) === today
    ).length;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('stTotal', total); set('stPending', pending); set('stCompleted', completed); set('stToday', dueToday);
}

function renderAssignmentCard(q) {
    const b = q.bookings; const p = b?.properties;
    const isDone = q.status === 'completed';
    const urg = q.trigger_type === 'complaint';
    const triggerLabel = { random: '🎲 Random Audit', complaint: '⚡ Complaint', premium: '⭐ Premium' }[q.trigger_type] || q.trigger_type;
    return `<div class="assign-card">
        <div>
            <div class="ac-badge ${isDone ? 'completed' : urg ? 'urgent' : 'pending'}">${isDone ? '✓ Completed' : triggerLabel}</div>
        </div>
        <div class="ac-title">${esc(p?.name || 'Unknown Property')}</div>
        <div class="ac-meta">
            <div class="ac-row"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>${esc(p?.city || '—')}</div>
            <div class="ac-row"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${esc(b?.service_type || '—')}</div>
            ${q.due_by ? `<div class="ac-row"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Due: ${formatDate(q.due_by)}</div>` : ''}
        </div>
        <div class="ac-actions">
            ${isDone
            ? `<button class="btn-ghost" style="width:100%;justify-content:center;opacity:.6;cursor:default;">✓ Report Submitted</button>`
            : `<button class="btn-primary" style="width:100%;justify-content:center;" onclick="startInspection('${esc(q.id)}')">Start Inspection</button>`
        }
        </div>
    </div>`;
}

function renderActiveAssignments() {
    const el = document.getElementById('assignmentsGrid');
    if (!el) return;
    const pending = allInspections.filter(q => q.status !== 'completed');
    el.innerHTML = pending.length === 0
        ? `<div style="grid-column:1/-1;text-align:center;padding:50px;background:var(--white);border-radius:14px;border:1px dashed var(--border);color:var(--muted);">No pending assignments 🎉</div>`
        : pending.map(renderAssignmentCard).join('');
}

function renderOverviewPending() {
    const el = document.getElementById('overviewPending');
    if (!el) return;
    const pending = allInspections.filter(q => q.status !== 'completed');
    if (pending.length === 0) {
        el.innerHTML = `<div style="padding:32px;text-align:center;background:var(--white);border-radius:14px;border:1px dashed var(--border);color:var(--muted);">No pending assignments — all clear! ✅</div>`;
        return;
    }
    el.innerHTML = `<div class="assign-grid">${pending.slice(0, 4).map(renderAssignmentCard).join('')}</div>`;
}

async function renderCompletedView() {
    const el = document.getElementById('completedList');
    if (!el) return;
    el.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading completed reports…</div>`;

    const { data: verifs, error } = await db.from('verifications')
        .select(`*, bookings(service_type, scheduled_date, scheduled_time, properties(name, city))`)
        .eq('inspector_id', currentUser.id)
        .order('created_at', { ascending: false });

    if (error || !verifs || verifs.length === 0) {
        el.innerHTML = `<div style="padding:40px;text-align:center;background:var(--white);border-radius:14px;border:1px dashed var(--border);color:var(--muted);">${error ? 'Error: ' + esc(error.message) : 'No completed reports yet.'}</div>`;
        return;
    }

    el.innerHTML = verifs.map(v => {
        const p = v.bookings?.properties;
        const passed = [v.roof_verified, v.plumbing_verified, v.electrical_verified, v.cleaning_verified, v.garden_verified, v.security_verified].filter(x => x === true).length;
        const total = chItems.length;
        return `<div class="hist-card">
            <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;">
                <span class="verdict-pill ${esc(v.verdict || 'approved')}">${esc(v.verdict || '—')}</span>
                <div>
                    <div style="font-weight:500;font-size:14px;color:var(--ink);">${esc(p?.name || 'Unknown Property')}</div>
                    <div style="font-size:12px;color:var(--muted);">${esc(p?.city || '')} · ${esc(v.bookings?.service_type || '')} · ${formatDate(v.created_at)}</div>
                </div>
                <div style="margin-left:auto;text-align:right;">
                    <div style="font-family:'Cormorant Garamond',serif;font-size:26px;color:var(--sage);">${passed}<span style="font-size:14px;">/${total}</span></div>
                    <div style="font-size:11px;color:var(--muted);">Checks Passed</div>
                </div>
            </div>
            ${v.inspector_notes ? `<div style="font-size:13px;color:var(--muted);padding:12px;background:var(--cream);border-radius:10px;line-height:1.6;">"${esc(v.inspector_notes)}"</div>` : ''}
        </div>`;
    }).join('');
}

function switchView(name) {
    document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    document.getElementById('nav-' + name).classList.add('active');
    if (name === 'completed') renderCompletedView();
}

function startInspection(qaId) {
    const q = allInspections.find(x => x.id === qaId);
    if (!q) { toast('This assignment is no longer available. Refresh the page.', 'error'); return; }
    openInsp(q.id, q.bookings?.properties || {}, q.booking_id, q.owner_id);
}

function openInsp(qaId, propObj, bookId, ownId) {
    activeAssignmentId = qaId;
    currentProp = typeof propObj === 'string' ? JSON.parse(propObj.replace(/&quot;/g, '"')) : propObj;
    activeBookingId = bookId;
    activeOwnerId = ownId;

    document.getElementById('gpsBox').style.display = 'block';
    document.getElementById('formContent').style.display = 'none';
    document.getElementById('gpsStatus').textContent = '';
    document.getElementById('btnCheckIn').textContent = 'Verify My Location';
    document.getElementById('btnSubmit').disabled = true;

    document.getElementById('checklist').innerHTML = chItems.map(c => `
        <div class="ch-item">
            <div class="ch-lbl">${c.label}</div>
            <div class="ch-opts" id="ch_${c.id}">
                <div class="ch-opt" onclick="setChk('${c.id}', true, this)">Pass</div>
                <div class="ch-opt" onclick="setChk('${c.id}', false, this)">Fail</div>
                <div class="ch-opt" onclick="setChk('${c.id}', null, this)">N/A</div>
            </div>
        </div>
    `).join('');

    document.getElementById('inspNotes').value = '';
    finalVerdict = 'approved';
    document.querySelectorAll('.verdict-opt').forEach((el, i) => { el.classList.toggle('sel', i === 0); });
    document.getElementById('inspModal').style.display = 'flex';
}

function closeInsp() { document.getElementById('inspModal').style.display = 'none'; }

function setChk(itemId, val, el) {
    const parent = document.getElementById('ch_' + itemId);
    parent.querySelectorAll('.ch-opt').forEach(btn => btn.className = 'ch-opt');
    el.className = `ch-opt sel ${val === true ? 'pass' : val === false ? 'fail' : 'na'}`;
    parent.dataset.val = String(val);
}

function setVerdict(el, val) {
    document.querySelectorAll('.verdict-opt').forEach(b => b.classList.remove('sel'));
    el.classList.add('sel'); finalVerdict = val;
}

function checkIn() {
    const btn = document.getElementById('btnCheckIn'); const msg = document.getElementById('gpsStatus');
    const propertyLat = Number(currentProp?.lat);
    const propertyLng = Number(currentProp?.lng);
    if (!Number.isFinite(propertyLat) || !Number.isFinite(propertyLng)) {
        msg.textContent = 'This property has no map location. Ask the owner to add one before inspection.';
        return;
    }
    if (!navigator.geolocation) { msg.textContent = 'Location is not available in this browser. Enable location to continue.'; return; }
    btn.disabled = true; btn.textContent = 'Locating…'; msg.textContent = '';

    navigator.geolocation.getCurrentPosition(
        pos => {
            const d = haversine(pos.coords.latitude, pos.coords.longitude, propertyLat, propertyLng);
            const radius = Number(currentProp?.geofence_radius);
            const allowedRadius = Number.isFinite(radius) && radius > 0 ? radius : 200;
            if (d <= allowedRadius) {
                btn.disabled = false;
                unlockForm();
            } else {
                btn.disabled = false; btn.textContent = 'Verify My Location';
                msg.textContent = `You are ${Math.round(d - allowedRadius)}m outside the property boundary. Move closer and try again.`;
            }
        },
        error => {
            btn.disabled = false; btn.textContent = 'Verify My Location';
            const messages = {
                1: 'Location permission was denied. Allow location access in your browser settings, then try again.',
                2: 'Your location could not be determined. Check that location services are on and try again.',
                3: 'Location lookup timed out. Try again in a place with a clearer GPS signal.'
            };
            msg.textContent = messages[error.code] || 'Could not verify your location. Try again.';
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

function unlockForm() {
    document.getElementById('gpsBox').style.display = 'none';
    document.getElementById('formContent').style.display = 'block';
    document.getElementById('btnSubmit').disabled = false;
    toast('Location Verified ✓', 'success');
}

async function submitInsp() {
    const btn = document.getElementById('btnSubmit');
    if (btn.disabled) return;
    let allOK = true;
    const checkData = {};

    chItems.forEach(c => {
        const raw = document.getElementById('ch_' + c.id).dataset.val;
        if (raw === undefined) { allOK = false; return; }
        // Convert string to boolean or null
        checkData[c.field] = raw === 'true' ? true : raw === 'false' ? false : null;
    });

    if (!allOK) { toast('Please complete all checklist items first.', 'error'); return; }

    btn.disabled = true; btn.textContent = 'Submitting…';
    const notes = document.getElementById('inspNotes').value;

    const insertPayload = {
        qa_assignment_id: activeAssignmentId,
        booking_id: activeBookingId,
        inspector_id: currentUser.id,
        owner_id: activeOwnerId,
        verdict: finalVerdict,
        inspector_notes: notes,
        ...checkData
    };

    const { error: vErr } = await db.from('verifications').insert([insertPayload]);

    if (vErr) { toast(vErr.message, 'error'); btn.disabled = false; btn.textContent = 'Submit Report'; return; }

    const { error: assignmentError } = await db.from('qa_assignments').update({
        status: 'completed',
        completed_at: new Date().toISOString()
    }).eq('id', activeAssignmentId);

    if (assignmentError) {
        toast('Report saved, but the assignment could not be marked complete: ' + assignmentError.message, 'error');
        btn.disabled = false; btn.textContent = 'Submit Report';
        await loadAssignments();
        return;
    }

    toast('Report submitted successfully! ✓', 'success');
    closeInsp();
    await loadAssignments();
}

init();
