// ── owner-dashboard.js ───────────────────────────────────────────
let currentUser = null;
let weatherLoaded = false;

async function init() {
    currentUser = await initAuth();
    if (!currentUser) return;

    await Promise.all([loadStats(), loadRecentBookings(), loadProperties(), loadAlerts(), loadInspectors()]);

    // Set default due date to tomorrow for QA modal
    const qaDate = document.getElementById('qaDueDate');
    if (qaDate) {
        qaDate.value = dateInputValueInKerala(1);
        setBookingDateMinimum(qaDate);
    }
}

// ════════════════════════════════════════════════════════════════
//  STATS
// ════════════════════════════════════════════════════════════════
async function loadStats() {
    const uid = currentUser.id;
    const [propsRes, bookingsRes, alertsRes] = await Promise.all([
        db.from('properties').select('id', { count: 'exact' }).eq('owner_id', uid),
        db.from('bookings').select('id, status, scheduled_date, scheduled_time, provider_id').eq('owner_id', uid),
        db.from('alerts').select('id', { count: 'exact' }).eq('owner_id', uid).eq('is_read', false)
    ]);

    const propCount = propsRes.count || 0;
    const bookings = bookingsRes.data || [];
    const alertCount = alertsRes.count || 0;
    const today = todayDateInputValue();
    const upcoming = bookings.filter(b => b.status !== 'completed' && b.scheduled_date >= today).length;
    const done = bookings.filter(b => b.status === 'completed').length;
    const active = bookings.filter(b => b.status === 'in_progress').length;

    document.getElementById('statProperties').textContent = propCount;
    document.getElementById('statUpcoming').textContent = upcoming;
    document.getElementById('statCompleted').textContent = done;
    document.getElementById('statAlerts').textContent = alertCount;
    document.getElementById('statActive').textContent = active;
    document.getElementById('alertTrend').textContent = alertCount > 0 ? 'New' : 'Clear';
    document.getElementById('alertTrend').className = alertCount > 0 ? 'stat-trend' : 'stat-trend trend-up';
}

// ════════════════════════════════════════════════════════════════
//  RECENT BOOKINGS TABLE
// ════════════════════════════════════════════════════════════════
async function loadRecentBookings() {
    const tbody = document.getElementById('recentTbody');
    const { data: bookings } = await db.from('bookings')
        .select('*, properties(name)')
        .eq('owner_id', currentUser.id)
        .order('scheduled_date', { ascending: false })
        .limit(8);

    if (!bookings?.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted);font-size:13px;">
            No bookings yet. <a href="owner-bookings.html" style="color:var(--sage);">Book a visit →</a></td></tr>`;
        return;
    }

    // Provider names (separate query)
    const provIds = [...new Set(bookings.map(b => b.provider_id).filter(Boolean))];
    let provMap = {};
    if (provIds.length) {
        const { data: provs } = await db.from('profiles').select('id,first_name,last_name').in('id', provIds);
        (provs || []).forEach(p => { provMap[p.id] = `${p.first_name || ''} ${p.last_name || ''}`.trim(); });
    }

    // Visit reports
    const bIds = bookings.map(b => b.id);
    const { data: reports } = await db.from('visit_reports')
        .select('booking_id,inside_geofence,checked_in_at,check_in_photo_url,checked_out_at')
        .in('booking_id', bIds);
    const rMap = {};
    (reports || []).forEach(r => { rMap[r.booking_id] = r; });

    // Live worker presence count
    const { data: wci } = await db.from('worker_checkins')
        .select('booking_id,worker_id,check_out_time').in('booking_id', bIds);
    const wMap = {};
    (wci || []).forEach(w => {
        if (!wMap[w.booking_id]) wMap[w.booking_id] = { in: 0, total: 0 };
        wMap[w.booking_id].total++;
        if (!w.check_out_time) wMap[w.booking_id].in++;
    });

    tbody.innerHTML = bookings.map(b => {
        const r = rMap[b.id];
        const pn = provMap[b.provider_id] || '—';
        const w = wMap[b.id];
        const ci = r?.checked_in_at
            ? `<span style="font-size:11px;font-weight:500;padding:3px 9px;border-radius:12px;${r.inside_geofence ? 'background:rgba(45,90,61,.1);color:var(--sage)' : 'background:rgba(220,38,38,.08);color:var(--error)'}">
                ${r.inside_geofence ? '✅ Inside' : '❌ Outside'}${r.check_in_photo_url ? ' 📸' : ''}
               </span>`
            : `<span style="font-size:11px;color:var(--muted);">—</span>`;
        const wBadge = w ? `<span style="font-size:10px;font-weight:500;padding:2px 7px;border-radius:10px;background:var(--sage-pale);color:var(--sage);cursor:pointer;" onclick="openMonitorModal('${b.id}')" title="Live Monitor">👷 ${w.in}/${w.total} (View)</span>` : '';

        return `<tr>
            <td><strong>${esc(b.properties?.name || '—')}</strong></td>
            <td>${esc(b.service_type || '—')}</td>
            <td>${formatBookingDateTime(b.scheduled_date, b.scheduled_time)}</td>
            <td style="font-size:12px;">${esc(pn)}</td>
            <td>${wBadge || '<span style="font-size:11px;color:var(--muted);">—</span>'}</td>
            <td><span class="status-badge ${b.status}">${(b.status || '—').replace('_', ' ')}</span></td>
            <td>${ci}</td>
            <td>${qaLabel(b.status, b.id)}</td>
        </tr>`;
    }).join('');
}

// ════════════════════════════════════════════════════════════════
//  PROPERTIES QUICK VIEW + WEATHER
// ════════════════════════════════════════════════════════════════
async function loadProperties() {
    const el = document.getElementById('propCards');
    const { data: props } = await db.from('properties')
        .select('id,name,city,state,lat,lng,geofence_radius,property_type')
        .eq('owner_id', currentUser.id);

    if (!props?.length) {
        el.innerHTML = `<div style="text-align:center;padding:40px 0;">
            <p style="font-size:13px;color:var(--muted);margin-bottom:14px;">No properties added yet.</p>
            <a href="owner-properties.html" class="btn-add-property">+ Add Property</a>
        </div>`;
        return;
    }

    // Fetch weather for all properties that have lat/lng
    const weatherMap = {};
    await Promise.all(props.filter(p => p.lat && p.lng).map(async p => {
        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lng}&current=temperature_2m,precipitation,weathercode,windspeed_10m&daily=precipitation_sum,temperature_2m_max&forecast_days=3&timezone=Asia%2FKolkata`;
            const res = await fetch(url);
            const wx = await res.json();
            weatherMap[p.id] = wx;
        } catch { }
    }));

    el.innerHTML = props.map(p => {
        const wx = weatherMap[p.id];
        const curr = wx?.current;
        const daily = wx?.daily;
        const typeIconMap = { house: '🏠', villa: '🏡', apartment: '🏢', office: '🏢', ancestral: '🏛️' };
        const icon = typeIconMap[p.property_type] || '🏠';

        // Weather card
        let wxHtml = '';
        if (curr) {
            const wcode = curr.weathercode;
            const rain = daily?.precipitation_sum?.[0] || 0;
            const rainAlert = rain > 20
                ? `<div style="margin-top:6px;font-size:10px;font-weight:500;color:var(--error);background:rgba(220,38,38,.07);padding:4px 8px;border-radius:6px;">⚠️ Heavy rain expected — check drainage</div>`
                : rain > 8
                    ? `<div style="margin-top:6px;font-size:10px;font-weight:500;color:var(--warn);background:rgba(217,119,6,.07);padding:4px 8px;border-radius:6px;">🌧️ Rain today — monitor for leaks</div>`
                    : '';
            const nextRains = (daily?.precipitation_sum || []).map((r, i) => ({ r, day: i })).filter(x => x.r > 5).slice(0, 2);
            wxHtml = `<div style="margin-top:8px;padding:10px 12px;background:rgba(59,130,246,.04);border-radius:8px;border:1px solid rgba(59,130,246,.1);">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="font-size:22px;">${wmoIcon(wcode)}</span>
                    <div>
                        <div style="font-size:13px;font-weight:500;">${curr.temperature_2m}°C · ${wmoDesc(wcode)}</div>
                        <div style="font-size:11px;color:var(--muted);">Wind ${curr.windspeed_10m} km/h · Rain today ${rain.toFixed(1)}mm</div>
                    </div>
                    <div style="margin-left:auto;text-align:right;">
                        <div style="font-size:10px;color:var(--muted);">Next 3 days max</div>
                        <div style="font-size:11px;">${(daily?.temperature_2m_max || []).map(t => t + '°').join(' / ')}</div>
                    </div>
                </div>
                ${rainAlert}
            </div>`;
        }

        return `<div style="padding:14px 0;border-bottom:1px solid var(--border);">
            <div style="display:flex;align-items:center;gap:12px;">
                <div style="width:42px;height:42px;border-radius:10px;background:var(--sage-pale);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">${icon}</div>
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:500;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.name)}</div>
                    <div style="font-size:12px;color:var(--muted);">${esc(p.city || '')}${p.state ? ', ' + esc(p.state) : ''} · 📍${p.geofence_radius || 200}m</div>
                </div>
                <a href="owner-properties.html" style="font-size:11px;color:var(--sage);">Edit</a>
            </div>
            ${wxHtml}
        </div>`;
    }).join('') + `<div style="text-align:center;padding-top:12px;"><a href="owner-properties.html" style="font-size:12px;color:var(--sage);">Manage all properties →</a></div>`;

    // Trigger seasonal reminders
    checkSeasonalReminders(props);
}

// ════════════════════════════════════════════════════════════════
//  SEASONAL REMINDERS (weather-aware)
// ════════════════════════════════════════════════════════════════
async function checkSeasonalReminders(props) {
    const month = new Date().getMonth() + 1; // 1-12
    const reminders = [];

    const season = month >= 6 && month <= 9 ? 'monsoon'
        : month >= 3 && month <= 5 ? 'summer'
            : 'winter';

    if (season === 'monsoon') {
        reminders.push({ title: '🌧️ Monsoon Season Alert', message: 'Check roof drainage, seal windows, inspect for leaks. Heavy rain expected in Kerala.' });
    } else if (season === 'summer') {
        reminders.push({ title: '☀️ Summer Maintenance', message: 'Check water supply systems, AC units, and shade structures. Inspect for heat damage.' });
    } else {
        reminders.push({ title: '🌿 Winter Maintenance', message: 'Good time for exterior painting, garden work, and general deep cleaning.' });
    }

    // Weather-based alerts for properties with lat/lng
    for (const p of props.filter(x => x.lat && x.lng)) {
        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lng}&daily=precipitation_sum,temperature_2m_max&forecast_days=7&timezone=Asia%2FKolkata`;
            const res = await fetch(url);
            const wx = await res.json();
            const maxRain = Math.max(...(wx?.daily?.precipitation_sum || [0]));
            const maxTemp = Math.max(...(wx?.daily?.temperature_2m_max || [0]));

            if (maxRain > 50) {
                await db.from('alerts').insert({
                    owner_id: currentUser.id,
                    property_id: p.id,
                    title: `⛈️ Heavy Rain Warning — ${p.name}`,
                    message: `Heavy rainfall (${maxRain.toFixed(0)}mm) forecast in next 7 days. Inspect roof, drainage, and basement. Consider booking a maintenance check.`,
                    type: 'weather'
                }).select().single().catch(() => { });
            } else if (maxTemp > 40) {
                await db.from('alerts').insert({
                    owner_id: currentUser.id,
                    property_id: p.id,
                    title: `🌡️ Heat Wave Warning — ${p.name}`,
                    message: `Temperatures above 40°C expected next week. Check water supply, cool roofs, and any heat-sensitive equipment.`,
                    type: 'weather'
                }).select().single().catch(() => { });
            }
        } catch { }
    }
}

// ════════════════════════════════════════════════════════════════
//  RECENT ALERTS
// ════════════════════════════════════════════════════════════════
async function loadAlerts() {
    const el = document.getElementById('alertCards');
    const { data: alerts } = await db.from('alerts')
        .select('*')
        .eq('owner_id', currentUser.id)
        .order('created_at', { ascending: false })
        .limit(5);

    if (!alerts?.length) {
        el.innerHTML = `<div style="text-align:center;padding:40px 0;color:var(--muted);font-size:13px;">No alerts yet. You're all clear! ✅</div>`;
        return;
    }

    const typeStyle = {
        warning: { bg: 'rgba(217,119,6,.08)', color: 'var(--warn)', icon: '⚠️' },
        danger: { bg: 'rgba(220,38,38,.08)', color: 'var(--error)', icon: '🚨' },
        weather: { bg: 'rgba(59,130,246,.08)', color: '#3b82f6', icon: '🌧️' },
        info: { bg: 'rgba(45,90,61,.07)', color: 'var(--sage)', icon: 'ℹ️' },
        success: { bg: 'rgba(22,163,74,.07)', color: 'var(--success)', icon: '✅' },
    };

    el.innerHTML = alerts.map(a => {
        const st = typeStyle[a.type] || typeStyle.info;
        const ago = timeAgo(a.created_at);
        return `<div style="display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);${a.is_read ? 'opacity:.6' : ''}" onclick="markRead('${a.id}', this)" style="cursor:pointer;">
            <div style="width:30px;height:30px;border-radius:8px;background:${st.bg};display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">${st.icon}</div>
            <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;">
                    ${!a.is_read ? `<span style="width:6px;height:6px;border-radius:50%;background:${st.color};display:inline-block;flex-shrink:0;"></span>` : ''}
                    ${esc(a.title || 'Alert')}
                </div>
                <div style="font-size:12px;color:var(--muted);margin-top:2px;line-height:1.5;">${esc(a.message || '')}</div>
            </div>
            <div style="font-size:11px;color:var(--muted);flex-shrink:0;white-space:nowrap;">${ago}</div>
        </div>`;
    }).join('') + `<div style="text-align:center;padding-top:12px;"><a href="owner-alerts.html" style="font-size:12px;color:var(--sage);">View all alerts →</a></div>`;
}

async function markRead(id, row) {
    row.style.opacity = '0.6';
    await db.from('alerts').update({ is_read: true }).eq('id', id);
}

init();

// ════════════════════════════════════════════════════════════════
//  QA INSPECTOR & LIVE MONITOR MODALS
// ════════════════════════════════════════════════════════════════
let activeBookingId = null;
let inspectors = [];

function qaLabel(status, bookingId) {
    const labels = {
        completed: { emoji: '✅', text: 'Verify Work', tip: 'Appoint a QA inspector to verify completed work' },
        in_progress: { emoji: '🔍', text: 'Spot Check', tip: 'Request a surprise quality audit mid-service' },
        confirmed: { emoji: '🎲', text: 'Random Audit', tip: 'Schedule a random audit before the visit' },
        pending: { emoji: '📋', text: 'Pre-Audit', tip: 'Request a QA inspector to audit before work begins' }
    };
    const l = labels[status] || labels['pending'];
    return `<button class="btn-ghost" style="font-size:11px;padding:4px 12px;white-space:nowrap;" title="${l.tip}" onclick="openQAModal(event, '${bookingId}','${status}')">${l.emoji} ${l.text}</button>`;
}

async function loadInspectors() {
    const { data } = await db.from('profiles').select('id, first_name, last_name').eq('role', 'qa_inspector');
    inspectors = data || [];
    const sel = document.getElementById('qaInspectorSelect');
    if (!sel) return;
    if (inspectors.length === 0) {
        sel.innerHTML = '<option value="">No inspectors available</option>';
    } else {
        sel.innerHTML = '<option value="">Select inspector…</option>';
        inspectors.forEach(i => {
            const o = document.createElement('option');
            o.value = i.id;
            o.textContent = ((i.first_name || '') + ' ' + (i.last_name || '')).trim() || 'Inspector';
            sel.appendChild(o);
        });
    }
}

function openQAModal(e, bookingId, status) {
    if (e) e.stopPropagation();
    setBookingDateMinimum(document.getElementById('qaDueDate'));
    activeBookingId = bookingId;
    const titles = { completed: 'Verify Completed Work', in_progress: 'Request Surprise Spot Check', confirmed: 'Schedule Random Audit', pending: 'Request Pre-Visit Audit' };
    const desc = {
        completed: 'Appoint a QA Inspector to physically verify all work claimed by the provider is done correctly.',
        in_progress: 'Assign a QA Inspector for an immediate surprise visit to check work in progress.',
        confirmed: 'Proactively schedule a random audit before the visit date for quality assurance.',
        pending: 'Schedule a pre-audit so the QA Inspector is already familiar with the property before work begins.'
    };
    const title = document.querySelector('#qaModal .modal-title');
    const descEl = document.querySelector('#qaModal .modal-body p');
    if (title) title.textContent = titles[status] || 'Appoint QA Inspector';
    if (descEl) descEl.textContent = desc[status] || 'Select an independent QA Inspector to verify work quality.';

    const triggerSel = document.getElementById('qaTriggerType');
    if (triggerSel) {
        if (status === 'completed') triggerSel.value = 'complaint';
        else if (status === 'in_progress') triggerSel.value = 'random';
        else triggerSel.value = 'random';
    }
    document.getElementById('qaModal').classList.add('open');
}
function closeQAModal() {
    document.getElementById('qaModal').classList.remove('open');
    activeBookingId = null;
}

async function submitQAAppoint() {
    const inspectorId = document.getElementById('qaInspectorSelect').value;
    const triggerType = document.getElementById('qaTriggerType').value;
    const dueDate = document.getElementById('qaDueDate').value;

    if (!inspectorId) { toast('Please select an inspector.', 'error'); return; }
    if (!dueDate) { toast('Please set a due date.', 'error'); return; }
    if (!isValidBookingDate(dueDate)) { toast('Please choose today or a future due date in Kerala time.', 'error'); return; }

    const { error } = await db.from('qa_assignments').insert({
        booking_id: activeBookingId,
        inspector_id: inspectorId,
        owner_id: currentUser.id,
        trigger_type: triggerType,
        due_by: dueDate,
        status: 'assigned'
    });
    if (error) { toast('Error: ' + error.message, 'error'); return; }

    await db.from('alerts').insert({
        owner_id: currentUser.id,
        title: 'QA Inspector Appointed',
        message: `A QA inspector has been appointed for your booking. They will visit before ${formatDate(dueDate)}.`,
        type: 'info'
    });

    toast('QA Inspector appointed! ✓', 'success');
    closeQAModal();
}

async function openMonitorModal(bookingId) {
    document.getElementById('monitorModal').classList.add('open');
    const list = document.getElementById('monitorList');
    list.innerHTML = '<div style="text-align:center;padding:20px;"><div class="spinner"></div></div>';

    const { data: checks, error } = await db.from('worker_checkins')
        .select('lat:check_in_lat, lng:check_in_lng, inside_geofence, check_in_time, check_out_time, provider_workers(first_name, last_name, phone)')
        .eq('booking_id', bookingId)
        .order('check_in_time', { ascending: false });

    if (error || !checks || checks.length === 0) {
        list.innerHTML = '<p style="text-align:center;color:var(--muted);padding:20px;">No workers have checked in for this booking yet.</p>';
        return;
    }

    list.innerHTML = checks.map(c => {
        const worker = c.provider_workers || {};
        const name = esc(`${worker.first_name || ''} ${worker.last_name || ''}`.trim() || 'Worker');
        const phone = esc(worker.phone || 'No phone');
        const stText = c.check_out_time ? 'Checked Out' : 'Active On-Site';
        const stColor = c.check_out_time ? 'var(--muted)' : 'var(--sage)';
        const geoText = c.inside_geofence ? '✅ Verified in Geofence' : '❌ Outside Geofence';
        const geoColor = c.inside_geofence ? 'var(--success)' : 'var(--error)';
        const mapLink = `<a href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}" target="_blank" style="color:#3b82f6;font-size:12px;margin-left:4px;">(Map)</a>`;

        return `
        <div style="padding:14px;border:1px solid var(--border);border-radius:12px;margin-bottom:12px;display:flex;align-items:center;gap:16px;">
            <div style="flex:1;">
                <div style="font-weight:600;font-size:15px;color:var(--ink);">${name} <span style="font-size:11px;font-weight:400;color:${stColor};margin-left:8px;padding:2px 8px;border-radius:10px;background:rgba(0,0,0,0.04);">${stText}</span></div>
                <div style="font-size:12px;color:var(--muted);margin-top:4px;">In: ${new Date(c.check_in_time).toLocaleTimeString()} ${c.check_out_time ? `| Out: ${new Date(c.check_out_time).toLocaleTimeString()}` : ''}</div>
                <div style="font-size:12px;color:${geoColor};margin-top:2px;font-weight:500;">${geoText} ${c.lat ? mapLink : ''}</div>
            </div>
            ${c.check_in_photo_url ? `<img src="${c.check_in_photo_url}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;border:1px solid var(--border);" alt="Check-in photo">` : ''}
        </div>`;
    }).join('');
}

function closeMonitorModal() {
    document.getElementById('monitorModal').classList.remove('open');
}
