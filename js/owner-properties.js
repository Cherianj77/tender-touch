// owner-properties.js — My Properties page logic
let currentUser = null;
let properties = [];
let mapPicker = null;
let mapMarker = null;
let mapCircle = null;
let geofenceRadius = 200;

async function init() {
    currentUser = await initAuth();
    if (!currentUser) return;
    await loadProperties();
}

async function loadProperties() {
    const grid = document.getElementById('propGrid');
    grid.innerHTML = `<div class="loading-row" style="grid-column:1/-1"><div class="spinner"></div>Loading…</div>`;

    const { data, error } = await db.from('properties').select('*').eq('owner_id', currentUser.id).order('created_at', { ascending: false });
    properties = error ? [] : (data || []);

    const label = document.getElementById('propCountLabel');
    if (label) label.textContent = properties.length === 0 ? 'No properties yet' : `${properties.length} propert${properties.length === 1 ? 'y' : 'ies'} registered`;

    renderPropGrid();
    properties.forEach(p => { if (p.lat && p.lng) fetchWeather(p.id, p.lat, p.lng); });
}

function renderPropGrid() {
    const grid = document.getElementById('propGrid');
    if (!properties || properties.length === 0) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon"><svg fill="none" stroke="currentColor" stroke-width="1.2" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg></div>
      <div class="empty-title">No properties yet</div>
      <div class="empty-desc">Add your first property to start managing it remotely.</div>
      <button class="btn-add-first" onclick="openAddModal()">
        <svg fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add First Property
      </button>
    </div>`;
        return;
    }
    grid.innerHTML = properties.map(p => {
        const isActive = p.is_active !== false;
        return `
    <div class="prop-card-full ${!isActive ? 'prop-inactive' : ''}">
      <div class="prop-card-map" id="minimap-${p.id}"></div>
      <div class="prop-card-body">
        <div class="prop-card-top">
          <div>
            <div class="prop-card-name">${esc(p.name)}</div>
            <div class="prop-card-loc">${esc(p.city)}, ${esc(p.state || 'Kerala')}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
            <span class="prop-tag">${esc(p.property_type || 'House')}</span>
            <span style="font-size:10px;padding:2px 8px;border-radius:12px;font-weight:600;
              background:${isActive ? 'rgba(22,163,74,.1)' : 'rgba(107,124,114,.1)'};
              color:${isActive ? 'var(--success)' : 'var(--muted)'};"
            >${isActive ? '● Active' : '○ Inactive'}</span>
          </div>
        </div>
        <div class="prop-card-weather" id="pw-${p.id}">Loading weather…</div>
        <div class="prop-card-fence">⬤ &nbsp;${p.geofence_radius || 200}m geo-fence radius</div>
        <div class="prop-card-actions" style="flex-wrap:wrap;">
          <a href="owner-bookings.html?prop=${p.id}" class="btn-primary" style="flex:1;min-width:120px;justify-content:center;">
            📅 Book Visit
          </a>
          <button class="btn-ghost" onclick="openEditModal('${p.id}')" style="flex:1;min-width:90px;">
            ✏️ Edit
          </button>
          <button class="btn-ghost" onclick="openMapView('${p.id}')" style="flex:1;min-width:90px;">
            🗺️ Map
          </button>
          <button class="btn-ghost" onclick="toggleActive('${p.id}', ${isActive})" style="flex:1;min-width:90px;color:${isActive ? 'var(--warn)' : 'var(--success)'}">
            ${isActive ? '⏸ Deactivate' : '▶ Activate'}
          </button>
          <button class="btn-ghost" onclick="deleteProp('${p.id}')" style="flex:1;min-width:90px;color:var(--error);">
            🗑 Delete
          </button>
        </div>
      </div>
    </div>`;
    }).join('');

    setTimeout(() => {
        properties.forEach(p => { if (p.lat && p.lng) initMiniMap(p.id, p.lat, p.lng, p.geofence_radius || 200); });
    }, 50);
}

function initMiniMap(propId, lat, lng, radius) {
    const el = document.getElementById('minimap-' + propId);
    if (!el || el._map) return;
    const m = L.map(el, { zoomControl: false, dragging: false, scrollWheelZoom: false, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(m);
    m.setView([lat, lng], 15);
    L.circleMarker([lat, lng], { radius: 8, fillColor: '#2d5a3d', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(m);
    L.circle([lat, lng], { radius, color: '#2d5a3d', fillColor: '#2d5a3d', fillOpacity: .12, weight: 1.5 }).addTo(m);
    el._map = m;
}

async function fetchWeather(propId, lat, lng) {
    try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true`);
        const j = await r.json(); const w = j.current_weather;
        const html = `${wmoIcon(w.weathercode)} ${Math.round(w.temperature)}°C · ${wmoDesc(w.weathercode)}${w.weathercode >= 80 ? ' ⚠ Rain expected' : ''}`;
        const el = document.getElementById('pw-' + propId);
        if (el) el.innerHTML = html;
    } catch {
        const el = document.getElementById('pw-' + propId);
        if (el) el.textContent = 'Weather unavailable';
    }
}

// ── Add Property Modal ────────────────────────────────
function openAddModal() {
    document.getElementById('addPropModal').classList.add('open');
    setTimeout(initMapPicker, 120);
}
function closeAddModal() {
    document.getElementById('addPropModal').classList.remove('open');
    if (mapPicker) { mapPicker.remove(); mapPicker = null; mapMarker = null; mapCircle = null; }
}

function initMapPicker() {
    if (mapPicker) return;
    mapPicker = L.map('map-picker').setView([10.85, 76.27], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(mapPicker);
    mapPicker.on('click', e => placePin(e.latlng.lat, e.latlng.lng));
}
function placePin(lat, lng) {
    document.getElementById('propLat').value = lat;
    document.getElementById('propLng').value = lng;
    if (mapMarker) mapPicker.removeLayer(mapMarker);
    if (mapCircle) mapPicker.removeLayer(mapCircle);
    mapMarker = L.marker([lat, lng]).addTo(mapPicker);
    mapCircle = L.circle([lat, lng], { radius: geofenceRadius, color: '#2d5a3d', fillColor: '#2d5a3d', fillOpacity: .15, weight: 2 }).addTo(mapPicker);
    mapPicker.setView([lat, lng], 16);
}
function updateRadius(val) {
    geofenceRadius = parseInt(val);
    document.getElementById('radiusDisplay').textContent = val + ' m';
    if (mapCircle) mapCircle.setRadius(geofenceRadius);
}
async function searchMap() {
    const q = document.getElementById('mapSearch').value.trim();
    if (!q) return;
    try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
        const d = await r.json();
        if (d.length) placePin(parseFloat(d[0].lat), parseFloat(d[0].lon));
        else toast('Location not found. Try a different search or click the map.', 'error');
    } catch { toast('Search failed. Click the map to pin manually.', 'error'); }
}

async function saveProperty() {
    const name = document.getElementById('propName').value.trim();
    const city = document.getElementById('propCity').value.trim();
    const state = document.getElementById('propDistrict').value;
    const type = document.getElementById('propType').value;
    const lat = parseFloat(document.getElementById('propLat').value);
    const lng = parseFloat(document.getElementById('propLng').value);

    if (!name) { toast('Please enter a property name.', 'error'); return; }
    if (!city) { toast('Please enter a city / town.', 'error'); return; }
    if (!state) { toast('Please select a district.', 'error'); return; }
    if (!lat || !lng) { toast('Please pin the location on the map.', 'error'); return; }

    const btn = document.getElementById('savePropBtn');
    btn.textContent = 'Saving…'; btn.disabled = true;

    const { error } = await db.from('properties').insert({
        owner_id: currentUser.id, name, city, state,
        property_type: type, lat, lng, geofence_radius: geofenceRadius
    });
    btn.textContent = 'Save Property'; btn.disabled = false;
    if (error) { toast(error.message, 'error'); return; }

    toast('Property saved! ✓', 'success');
    closeAddModal();
    ['propName', 'propCity', 'propNotes', 'propSize'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('propDistrict').value = '';
    await loadProperties();
}

async function deleteProp(id) {
    // Deleting cascades to bookings, payments and visit reports; keep history safe.
    const { count, error: countErr } = await db.from('bookings')
        .select('id', { count: 'exact', head: true }).eq('property_id', id);
    if (countErr || count == null) { toast('Could not check bookings; nothing was deleted.', 'error'); return; }
    if (count > 0) { toast(`This property has ${count} booking(s); deactivate it instead to keep its visit history.`, 'error'); return; }
    if (!await confirmDialog('Delete this property? This cannot be undone.', { okLabel: 'Delete', danger: true })) return;
    const { error } = await db.from('properties').delete().eq('id', id);
    if (error) { toast(error.message, 'error'); return; }
    toast('Property deleted.', 'success');
    await loadProperties();
}

async function toggleActive(id, currentlyActive) {
    const { error } = await db.from('properties').update({ is_active: !currentlyActive }).eq('id', id);
    if (error) { toast(error.message, 'error'); return; }
    toast(currentlyActive ? 'Property deactivated.' : 'Property activated! ✓', 'success');
    await loadProperties();
}

// ── Edit Property Modal ───────────────────────────────────────────
let editingPropId = null;
let editMap = null, editMarker = null, editCircle = null;
let editRadius = 200;

function openEditModal(id) {
    const p = properties.find(x => x.id === id);
    if (!p) return;
    editingPropId = id;
    editRadius = p.geofence_radius || 200;

    document.getElementById('editName').value = p.name || '';
    document.getElementById('editCity').value = p.city || '';
    document.getElementById('editDistrict').value = p.state || '';
    document.getElementById('editType').value = p.property_type || 'House';
    document.getElementById('editRadius').value = editRadius;
    document.getElementById('editRadiusDisplay').textContent = editRadius + ' m';
    document.getElementById('editLat').value = p.lat || '';
    document.getElementById('editLng').value = p.lng || '';

    document.getElementById('editPropModal').classList.add('open');

    setTimeout(() => {
        if (editMap) { editMap.remove(); editMap = null; editMarker = null; editCircle = null; }
        editMap = L.map('edit-map-picker').setView([p.lat || 10.85, p.lng || 76.27], p.lat ? 15 : 8);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(editMap);
        if (p.lat && p.lng) {
            editMarker = L.marker([p.lat, p.lng]).addTo(editMap);
            editCircle = L.circle([p.lat, p.lng], { radius: editRadius, color: '#2d5a3d', fillColor: '#2d5a3d', fillOpacity: .15, weight: 2 }).addTo(editMap);
        }
        editMap.on('click', e => placeEditPin(e.latlng.lat, e.latlng.lng));
    }, 120);
}

function closeEditModal() {
    document.getElementById('editPropModal').classList.remove('open');
    if (editMap) { editMap.remove(); editMap = null; }
    editingPropId = null;
}

function placeEditPin(lat, lng) {
    document.getElementById('editLat').value = lat;
    document.getElementById('editLng').value = lng;
    if (editMarker) editMap.removeLayer(editMarker);
    if (editCircle) editMap.removeLayer(editCircle);
    editMarker = L.marker([lat, lng]).addTo(editMap);
    editCircle = L.circle([lat, lng], { radius: editRadius, color: '#2d5a3d', fillColor: '#2d5a3d', fillOpacity: .15, weight: 2 }).addTo(editMap);
    editMap.setView([lat, lng], 16);
}

function updateEditRadius(val) {
    editRadius = parseInt(val);
    document.getElementById('editRadiusDisplay').textContent = val + ' m';
    if (editCircle) editCircle.setRadius(editRadius);
}

async function saveEdit() {
    const name = document.getElementById('editName').value.trim();
    const city = document.getElementById('editCity').value.trim();
    const state = document.getElementById('editDistrict').value;
    const type = document.getElementById('editType').value;
    const lat = parseFloat(document.getElementById('editLat').value);
    const lng = parseFloat(document.getElementById('editLng').value);

    if (!name) { toast('Please enter a property name.', 'error'); return; }
    if (!city) { toast('Please enter a city / town.', 'error'); return; }

    const btn = document.getElementById('saveEditBtn');
    btn.textContent = 'Saving…'; btn.disabled = true;

    const patch = { name, city, state, property_type: type, geofence_radius: editRadius };
    if (!isNaN(lat) && !isNaN(lng)) { patch.lat = lat; patch.lng = lng; }

    const { error } = await db.from('properties').update(patch).eq('id', editingPropId);
    btn.textContent = 'Save Changes'; btn.disabled = false;
    if (error) { toast(error.message, 'error'); return; }

    toast('Property updated! ✓', 'success');
    closeEditModal();
    await loadProperties();
}

// ── Map View Modal ────────────────────────────────────────────────
let viewMap = null;

function openMapView(id) {
    const p = properties.find(x => x.id === id);
    if (!p || !p.lat) { toast('No GPS pin set for this property.', 'error'); return; }
    document.getElementById('mapViewTitle').textContent = p.name;
    document.getElementById('mapViewModal').classList.add('open');
    setTimeout(() => {
        if (viewMap) { viewMap.remove(); viewMap = null; }
        viewMap = L.map('view-map').setView([p.lat, p.lng], 16);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(viewMap);
        L.circleMarker([p.lat, p.lng], { radius: 8, fillColor: '#2d5a3d', color: '#fff', weight: 2, fillOpacity: 1 })
            .addTo(viewMap).bindPopup(`<b>${esc(p.name || 'Property')}</b><br>${esc(p.city || '')}`).openPopup();
        L.circle([p.lat, p.lng], { radius: p.geofence_radius || 200, color: '#2d5a3d', fillColor: '#2d5a3d', fillOpacity: .12, weight: 2 })
            .addTo(viewMap);
    }, 120);
}

function closeMapView() {
    document.getElementById('mapViewModal').classList.remove('open');
    if (viewMap) { viewMap.remove(); viewMap = null; }
}

init();
