// owner-reports.js — Inspection Reports page
let currentUser = null;
let allReports = [];
let properties = {};
let reportMap = null;

const SERVICE_PRICES = {
    'General Cleaning': 1500, 'Deep Cleaning': 3500, 'Plumbing Check': 1200,
    'Electrical Check': 1200, 'Garden Maintenance': 2000, 'Pest Control': 2500,
    'Monsoon Prep': 3000, 'Security Check': 1000, 'Full Inspection': 5000
};

async function init() {
  currentUser = await initAuth();
  if (!currentUser) return;
  await loadReports();
}

async function loadReports() {
  document.getElementById('reportsList').innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading…</div>`;

  // Load owner's properties (for filter + map data)
  const { data: props } = await db.from('properties')
    .select('id, name, lat, lng, geofence_radius')
    .eq('owner_id', currentUser.id);
  (props || []).forEach(p => { properties[p.id] = p; });

  // Populate filter dropdown
  const sel = document.getElementById('filterProp');
  (props || []).forEach(p => {
    const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
  });

  // Load visit reports for owner's properties
  const propIds = (props || []).map(p => p.id);
  if (propIds.length === 0) {
    renderEmpty(); return;
  }

  // Get bookings for these properties
  const { data: bookings } = await db.from('bookings')
    .select('id, property_id, service_type, scheduled_date, scheduled_time, status, provider_id, properties(name, lat, lng, geofence_radius)')
    .in('property_id', propIds)
    .order('scheduled_date', { ascending: false });

  if (!bookings || bookings.length === 0) { renderEmpty(); return; }

  const bookingIds = bookings.map(b => b.id);

  // Get visit reports — fetch new columns too
  const { data: reports } = await db.from('visit_reports')
    .select('booking_id, provider_id, checked_in_at, checked_out_at, check_in_lat, check_in_lng, inside_geofence, check_in_photo_url, before_photo_url, after_photo_url, condition, checklist, notes')
    .in('booking_id', bookingIds);

  // Fetch provider names separately (avoids PGRST200 FK join error)
  const providerIds = [...new Set((reports || []).map(r => r.provider_id).filter(Boolean).concat(bookings.map(b => b.provider_id).filter(Boolean)))];
  let provNames = {};
  if (providerIds.length) {
    const { data: provs } = await db.from('profiles').select('id,first_name,last_name').in('id', providerIds);
    (provs || []).forEach(p => { provNames[p.id] = `${p.first_name || ''} ${p.last_name || ''}`.trim(); });
  }

  const reportsByBooking = {};
  (reports || []).forEach(r => {
    reportsByBooking[r.booking_id] = { ...r, provName: provNames[r.provider_id] || 'Provider' };
  });

  // Get job workers assigned per booking
  const { data: jw } = await db.from('job_workers')
    .select('booking_id, worker_id')
    .in('booking_id', bookingIds);

  // Get worker checkins per booking
  const { data: wci } = await db.from('worker_checkins')
    .select('booking_id, worker_id, inside_geofence, check_in_time, check_out_time')
    .in('booking_id', bookingIds);

  // Fetch worker names from provider_workers
  const allWorkerIds = [...new Set([
    ...(jw || []).map(x => x.worker_id),
    ...(wci || []).map(x => x.worker_id)
  ].filter(Boolean))];
  let workerNames = {};
  if (allWorkerIds.length) {
    const { data: pw } = await db.from('provider_workers').select('id, first_name, last_name').in('id', allWorkerIds);
    (pw || []).forEach(p => { workerNames[p.id] = p; });
  }

  // Attach worker names to checkins
  const enrichedWci = (wci || []).map(w => ({
    ...w,
    provider_workers: workerNames[w.worker_id] || null
  }));

  // Merge
  allReports = bookings.map(b => ({
    ...b,
    report: reportsByBooking[b.id] || null,
    jobWorkers: (jw || []).filter(x => x.booking_id === b.id),
    workerCheckins: enrichedWci.filter(x => x.booking_id === b.id)
  }));

  document.getElementById('totalCount').textContent = `${allReports.length} visit${allReports.length !== 1 ? 's' : ''} total`;
  renderReports(allReports);
}

function renderReports(list) {
  const container = document.getElementById('reportsList');
  if (!list || list.length === 0) { renderEmpty(); return; }

  container.innerHTML = list.map(item => {
    const r = item.report;
    const prop = item.properties;
    const hasReport = !!r;
    const inside = r ? r.inside_geofence : null;
    const cls = hasReport ? (inside ? 'pass' : 'fail') : 'pending';
    const badge = hasReport
      ? (inside ? '✅ Inside Geo-fence' : '❌ Outside Geo-fence')
      : '⏳ Awaiting Check-in';
    const checkinTime = r?.checked_in_at ? new Date(r.checked_in_at).toLocaleString('en-IN') : '—';
    const checkoutTime = r?.checked_out_at ? new Date(r.checked_out_at).toLocaleString('en-IN') : '—';
    const provName = r?.provName || (item.properties?.name ? 'Provider' : 'Unassigned');

    // Photo stamp
    const photoHtml = r?.check_in_photo_url
      ? `<div style="grid-column:1/-1;margin-top:4px;">
           <div class="rc-detail-label">📸 Check-in Photo Stamp</div>
           <div style="margin-top:8px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;">
             <a href="${r.check_in_photo_url}" target="_blank">
               <img src="${r.check_in_photo_url}" alt="Check-in photo" style="width:180px;height:130px;object-fit:cover;border-radius:10px;border:2px solid var(--border);cursor:pointer;" title="Click to view full photo">
             </a>
             <div style="font-size:11px;color:var(--muted);line-height:1.8;">
               <div><strong style="color:var(--ink);">Captured at:</strong> ${checkinTime}</div>
               <div><strong style="color:var(--ink);">Provider:</strong> ${esc(provName)}</div>
               ${r?.check_in_lat ? `<div><strong style="color:var(--ink);">GPS:</strong> ${parseFloat(r.check_in_lat).toFixed(5)}, ${parseFloat(r.check_in_lng).toFixed(5)}</div>` : ''}
               <div style="margin-top:8px;">
                 <span style="padding:4px 10px;border-radius:20px;font-size:11px;font-weight:500;${inside ? 'background:rgba(45,90,61,.1);color:var(--sage)' : 'background:rgba(220,38,38,.08);color:var(--error)'}">
                   ${inside ? '✅ Geo-fence: INSIDE' : '❌ Geo-fence: OUTSIDE'}
                 </span>
               </div>
             </div>
           </div>
         </div>`
      : '';

    // Worker attendance pill
    const wTotal = item.jobWorkers?.length || 0;
    const wOnsite = item.workerCheckins?.filter(w => w.inside_geofence).length || 0;
    const wOut = item.workerCheckins?.filter(w => !w.inside_geofence).length || 0;
    const wPill = wTotal === 0
      ? ''
      : wOnsite === wTotal
        ? `<span style="font-size:11px;font-weight:500;padding:4px 10px;border-radius:12px;background:rgba(45,90,61,.1);color:var(--sage);margin-left:8px;">👷 ${wOnsite}/${wTotal} on-site</span>`
        : `<span style="font-size:11px;font-weight:500;padding:4px 10px;border-radius:12px;background:rgba(220,38,38,.08);color:var(--error);margin-left:8px;">⚠️ ${wOnsite}/${wTotal} on-site</span>`;

    // Worker checkin detail rows
    const wRows = (item.workerCheckins || []).map(w => {
      const pw = w.provider_workers || {};
      const wName = `${pw.first_name || ''} ${pw.last_name || ''}`.trim() || 'Worker';
      return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);">
                <div style="width:28px;height:28px;border-radius:50%;background:var(--sage-pale);display:flex;align-items:center;justify-content:center;font-size:12px;font-family:'Cormorant Garamond',serif;color:var(--sage);flex-shrink:0;">${(wName[0] || '?').toUpperCase()}</div>
                <div style="flex:1;font-size:12px;">${esc(wName)}</div>
                <span style="font-size:11px;font-weight:500;padding:3px 9px;border-radius:12px;${w.inside_geofence ? 'background:rgba(45,90,61,.1);color:var(--sage)' : 'background:rgba(220,38,38,.08);color:var(--error)'}">${w.inside_geofence ? '✅ Inside' : '❌ Outside'}</span>
                <span style="font-size:10px;color:var(--muted);">${timeAgo(w.check_in_time)}</span>
            </div>`;
    }).join('');

    // GPS link
    const gpsLink = r?.check_in_lat
      ? `<a href="https://maps.google.com?q=${r.check_in_lat},${r.check_in_lng}" target="_blank" style="font-size:11px;color:var(--sage);display:inline-flex;align-items:center;gap:4px;margin-top:4px;"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>View on Google Maps</a>`
      : '';

    return `
    <div class="report-card ${cls}">
      <div class="rc-header" onclick="toggleReport('rc-${item.id}')">
        <div class="rc-icon ${cls}">
          <svg width="20" height="20" fill="none" stroke="${cls === 'pass' ? 'var(--success)' : cls === 'fail' ? 'var(--error)' : 'var(--warn)'}" stroke-width="1.8" viewBox="0 0 24 24">
            ${cls === 'pass' ? '<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>'
        : cls === 'fail' ? '<path d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/>'
          : '<path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>'}
          </svg>
        </div>
        <div style="flex:1;min-width:0;">
          <div class="rc-prop">${esc(prop?.name || '—')} · ${esc(item.service_type)} · <span style="color:var(--sage);font-weight:500;">₹${(SERVICE_PRICES[item.service_type] || 0).toLocaleString('en-IN')}</span>${wPill}</div>
          <div class="rc-meta">${formatBookingDateTime(item.scheduled_date, item.scheduled_time)} · Provider: ${esc(provName)}</div>
        </div>
        <span class="rc-badge ${cls}">${badge}</span>
        ${r?.check_in_photo_url ? `<span style="font-size:11px;background:rgba(45,90,61,.08);color:var(--sage);padding:4px 9px;border-radius:8px;margin-right:6px;white-space:nowrap;">📸 Photo</span>` : ''}
        ${r?.check_in_lat ? `<button class="rc-map-btn" onclick="event.stopPropagation();openMap(${JSON.stringify(item).replace(/"/g, '&quot;')})">🗺 Map</button>` : ''}
      </div>
      <div class="rc-body" id="rc-${item.id}">
        <div><div class="rc-detail-label">Check-in Time</div><div class="rc-detail-val">${checkinTime}</div></div>
        <div><div class="rc-detail-label">Check-out Time</div><div class="rc-detail-val">${checkoutTime}</div></div>
        <div><div class="rc-detail-label">Geo-fence Radius</div><div class="rc-detail-val">${prop?.geofence_radius || 200}m</div></div>
        <div><div class="rc-detail-label">Condition</div><div class="rc-detail-val">${r?.condition ? ({ good: '✅ Good', partial: '⚠️ Partial', issue: '❌ Issue' }[r.condition] || r.condition) : '—'}</div></div>
        <div><div class="rc-detail-label">Provider Notes</div><div class="rc-detail-val">${esc(r?.notes || '—')}</div></div>
        ${r?.check_in_lat ? `<div style="grid-column:1/-1"><div class="rc-detail-label">GPS Coordinates</div><div class="rc-detail-val">Lat: ${parseFloat(r.check_in_lat).toFixed(6)}, Lng: ${parseFloat(r.check_in_lng).toFixed(6)} ${gpsLink}</div></div>` : ''}
        ${photoHtml}
        ${(r?.before_photo_url || r?.after_photo_url) ? `
        <div style="grid-column:1/-1;margin-top:8px;">
          <div class="rc-detail-label" style="margin-bottom:8px;">📷 Before &amp; After Photos</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${r.before_photo_url ? `<div><div style="font-size:10px;color:var(--muted);margin-bottom:4px;">BEFORE</div><a href="${r.before_photo_url}" target="_blank"><img src="${r.before_photo_url}" style="width:150px;height:110px;object-fit:cover;border-radius:8px;border:1px solid var(--border);" alt="Before"></a></div>` : ''}
            ${r.after_photo_url ? `<div><div style="font-size:10px;color:var(--muted);margin-bottom:4px;">AFTER</div><a href="${r.after_photo_url}" target="_blank"><img src="${r.after_photo_url}" style="width:150px;height:110px;object-fit:cover;border-radius:8px;border:1px solid var(--border);" alt="After"></a></div>` : ''}
          </div>
        </div>` : ''}
        ${r?.checklist && Object.keys(r.checklist).length ? `
        <div style="grid-column:1/-1;margin-top:8px;">
          <div class="rc-detail-label" style="margin-bottom:8px;">✅ Service Checklist</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${Object.entries(r.checklist).map(([k, v]) => `<span style="font-size:11px;padding:3px 9px;border-radius:12px;${v ? 'background:rgba(22,163,74,.08);color:var(--success)' : 'background:rgba(107,124,114,.07);color:var(--muted)'}">
              ${v ? '✅' : '—'} ${esc(k)}
            </span>`).join('')}
          </div>
        </div>` : ''}
        ${wRows ? `<div style="grid-column:1/-1;margin-top:8px;"><div class="rc-detail-label" style="margin-bottom:8px;">Worker Check-ins (${item.workerCheckins?.length || 0}/${item.jobWorkers?.length || 0} on-site)</div>${wRows}</div>` : ''}
      </div>
    </div>`;

  }).join('');
}

function toggleReport(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

function renderEmpty() {
  document.getElementById('reportsList').innerHTML = `<div class="empty-state">
    <div class="empty-icon"><svg fill="none" stroke="currentColor" stroke-width="1.2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
    <div class="empty-title">No inspection reports yet</div>
    <div class="empty-desc">Reports will appear here once a provider checks in for a visit. The GPS coordinates and geo-fence verification result are shown for each visit.</div>
    <a href="owner-bookings.html" class="btn-add-first">Book a Visit →</a>
  </div>`;
}

function applyFilter() {
  const propId = document.getElementById('filterProp').value;
  const status = document.getElementById('filterStatus').value;
  let filtered = [...allReports];
  if (propId) filtered = filtered.filter(r => r.property_id === propId);
  if (status === 'pass') filtered = filtered.filter(r => r.report?.inside_geofence === true);
  if (status === 'fail') filtered = filtered.filter(r => r.report && r.report.inside_geofence === false);
  if (status === 'pending') filtered = filtered.filter(r => !r.report);
  document.getElementById('totalCount').textContent = `${filtered.length} result${filtered.length !== 1 ? 's' : ''}`;
  renderReports(filtered);
}

// ── GPS Map Modal ─────────────────────────────────────
function openMap(item) {
  const r = item.report;
  const prop = item.properties;
  if (!r?.check_in_lat || !prop?.lat) return;

  document.getElementById('mapModal').classList.add('open');
  document.getElementById('mapModalTitle').textContent = `GPS Check-in · ${prop.name || 'Property'}`;

  setTimeout(() => {
    if (reportMap) { reportMap.remove(); reportMap = null; }
    reportMap = L.map('reportMap');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(reportMap);

    const propLat = parseFloat(prop.lat);
    const propLng = parseFloat(prop.lng);
    const cinLat = parseFloat(r.check_in_lat);
    const cinLng = parseFloat(r.check_in_lng);
    const radius = prop.geofence_radius || 200;
    const inside = r.inside_geofence;

    // Property pin (dark green)
    L.circleMarker([propLat, propLng], {
      radius: 9, fillColor: '#2d5a3d', color: '#fff', weight: 2, fillOpacity: 1
    }).addTo(reportMap).bindPopup('🏠 Property Location').openPopup();

    // Geo-fence circle
    L.circle([propLat, propLng], {
      radius, color: '#2d5a3d', fillColor: '#2d5a3d', fillOpacity: .1, weight: 2, dashArray: '6,4'
    }).addTo(reportMap);

    // Provider check-in pin (green if inside, red if outside)
    const pinColor = inside ? '#16a34a' : '#dc2626';
    L.circleMarker([cinLat, cinLng], {
      radius: 10, fillColor: pinColor, color: '#fff', weight: 2.5, fillOpacity: 0.9
    }).addTo(reportMap).bindPopup(`${inside ? '✅' : '❌'} Provider Check-in`);

    // Fit both points
    reportMap.fitBounds([[propLat, propLng], [cinLat, cinLng]], { padding: [40, 40] });
  }, 80);
}

function closeMap() {
  document.getElementById('mapModal').classList.remove('open');
  if (reportMap) { reportMap.remove(); reportMap = null; }
}

init();
