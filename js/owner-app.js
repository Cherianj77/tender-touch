console.log('OWNER-APP-JS: Loaded v2-Satellite');
// js/owner-app.js - Unified Controller
const app = {
    currentUser: null,
    properties: {
        data: [],
        mapPicker: null,
        mapMarker: null,
        mapCircle: null,
        geofenceRadius: 200,
        layers: null
    },
    bookings: { data: [], activeBookingId: null, inspectors: [] },
    reports: { data: [], propsMap: {}, map: null },
    alerts: { data: [] },
    pendingBookingData: null,
    pendingExistingBookingId: null,
    pendingPayAmount: 0,
    SERVICE_PRICES: {
        'General Cleaning': 1500, 'Deep Cleaning': 3500, 'Plumbing Check': 1200,
        'Electrical Check': 1200, 'Garden Maintenance': 2000, 'Pest Control': 2500,
        'Monsoon Prep': 3000, 'Security Check': 1000, 'Full Inspection': 5000
    },
    esc(str) {
        return esc(str);
    },

    async init() {
        this.currentUser = await initAuth(false);
        if (!this.currentUser) return;

        // Initialize Map Layers after Leaflet is ready
        this.properties.layers = {
            street: // CARTO basemaps now require an API key; OpenStreetMap's standard tiles do not.
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }),
            sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EBP, and the GIS User Community' })
        };

        await this.bookings.loadInspectors();
        this.alerts.subscribeRealTime();
        this.alerts.load();
        const hash = window.location.hash.replace('#', '') || 'dashboard';
        this.showView(hash);
    },

    showView(viewName) {
        window.history.replaceState(null, null, '#' + viewName);
        document.querySelectorAll('.app-view').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => el.classList.remove('active'));
        const viewEl = document.getElementById('view-' + viewName);
        if (viewEl) viewEl.classList.add('active');
        const navEl = document.querySelector(`.sidebar-nav .nav-item[data-nav="${viewName}"]`);
        if (navEl) navEl.classList.add('active');

        if (viewName === 'dashboard') this.dashboard.load();
        else {
            // Clear worksite auto-refresh when leaving dashboard
            if (this.dashboard._refreshTimer) {
                clearInterval(this.dashboard._refreshTimer);
                this.dashboard._refreshTimer = null;
            }
            if (viewName === 'properties') this.properties.load();
            else if (viewName === 'bookings') this.bookings.load();
            else if (viewName === 'reports') this.reports.load();
            else if (viewName === 'alerts') this.alerts.load();
        }
    },

    dashboard: {
        _refreshTimer: null,
        async load() {
            this.loadStats();
            this.loadRecentBookings();
            this.loadProperties();
            this.loadAlerts();
            this.loadLiveWorksite();
            // Auto-refresh worksite status every 30 seconds
            if (this._refreshTimer) clearInterval(this._refreshTimer);
            this._refreshTimer = setInterval(() => this.loadLiveWorksite(), 30000);
        },
        async loadStats() {
            const [{ count: props }, { count: upcoming }, { count: completed }, { count: active }] = await Promise.all([
                db.from('properties').select('*', { count: 'exact', head: true }).eq('owner_id', app.currentUser.id).or('is_active.is.null,is_active.eq.true'),
                db.from('bookings').select('*', { count: 'exact', head: true }).eq('owner_id', app.currentUser.id).in('status', ['pending', 'confirmed']),
                db.from('bookings').select('*', { count: 'exact', head: true }).eq('owner_id', app.currentUser.id).eq('status', 'completed'),
                db.from('bookings').select('*', { count: 'exact', head: true }).eq('owner_id', app.currentUser.id).eq('status', 'in_progress')
            ]);
            if (document.getElementById('statProperties')) document.getElementById('statProperties').textContent = props || 0;
            if (document.getElementById('statUpcoming')) document.getElementById('statUpcoming').textContent = upcoming || 0;
            if (document.getElementById('statCompleted')) document.getElementById('statCompleted').textContent = completed || 0;

            // "Active" = in_progress or confirmed bookings for today
            const { count: liveActive } = await db.from('bookings')
                .select('id', { count: 'exact', head: true })
                .eq('owner_id', app.currentUser.id)
                .in('status', ['in_progress', 'confirmed'])
                .gte('scheduled_date', todayDateInputValue());

            if (document.getElementById('statActive')) document.getElementById('statActive').textContent = liveActive || 0;
        },
        async loadRecentBookings() {
            // Using count: 'exact' on related tables can be tricky in some versions of Supabase JS, 
            // fetching the full array and checking length is safer for this project's dashboard.
            const { data, error } = await db.from('bookings')
                .select('*, properties(name), job_workers(id), worker_checkins(id, check_in_time)')
                .eq('owner_id', app.currentUser.id)
                .order('scheduled_date', { ascending: false })
                .limit(5);

            if (error) { console.error('Dashboard bookings error:', error.message); return; }
            const tbody = document.getElementById('recentTbody');
            if (!tbody) return;
            if (!data || data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted);font-size:13px;">No recent bookings</td></tr>`;
                return;
            }
            tbody.innerHTML = data.map(b => {
                const wCount = b.job_workers?.length || 0;
                const cCount = b.worker_checkins?.length || 0;
                let wBadge = '';
                if (wCount > 0) {
                    const allIn = cCount === wCount;
                    wBadge = `<div class="worker-badge ${allIn ? 'all-in' : ''}" onclick="app.openMonitorModal('${b.id}')">
                      <div class="pulse-dot ${allIn ? 'green' : 'orange'}"></div>
                      ${cCount} / ${wCount} Workers
                    </div>`;
                }
                const firstCheckIn = (b.worker_checkins || []).map(c => c.check_in_time).filter(Boolean).sort()[0];
                const ci = firstCheckIn ? `<span style="color:var(--success)">✅ ${new Date(firstCheckIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : `<span style="color:var(--muted)">—</span>`;
                return `<tr>
                    <td><strong>${app.esc(b.properties?.name || '—')}</strong></td>
                    <td>${app.esc(b.service_type || '—')}</td>
                    <td>${app.esc(formatBookingDateTime(b.scheduled_date, b.scheduled_time) || '—')}</td>
                    <td>${b.provider_id ? '✅ Assigned' : '⚠️ No provider'}</td>
                    <td>${wBadge || '—'}</td>
                    <td><span class="status-badge ${app.esc(b.status || 'pending')}">${app.esc((b.status || 'pending').replace('_', ' '))}</span></td>
                    <td>${ci}</td>
                    <td>
                        <div style="display:flex;gap:5px;align-items:center;">
                            ${app.dashboard.qaLabel(b.status, b.id)}
                            ${['pending', 'confirmed'].includes(b.status) ? `<button class="btn-ghost" style="font-size:11px;padding:4px 10px;color:var(--error);" onclick="app.bookings.cancelBooking('${b.id}')">Cancel</button>` : ''}
                        </div>
                    </td>
                </tr>`;
            }).join('');
        },
        qaLabel(status, bookingId) {
            if (status === 'cancelled') return '';
            const labels = {
                completed: { emoji: '✅', text: 'Verify Work', tip: 'Appoint a QA inspector to verify completed work' },
                in_progress: { emoji: '🔍', text: 'Spot Check', tip: 'Request a surprise quality audit mid-service' },
                confirmed: { emoji: '🎲', text: 'Random Audit', tip: 'Schedule a random audit before the visit' },
                pending: { emoji: '📋', text: 'Pre-Audit', tip: 'Request a QA inspector to audit before work begins' }
            };
            const l = labels[status] || labels.pending;
            return `<button class="btn-ghost" style="font-size:11px;padding:4px 12px;white-space:nowrap;" title="${l.tip}" onclick="app.openQAModal(event, '${bookingId}', '${status}')">${l.emoji} ${l.text}</button>`;
        },
        async loadLiveWorksite() {
            const el = document.getElementById('liveWorksiteBody');
            if (!el) return;

            const today = todayDateInputValue();

            // Fetch active/in-progress bookings for this owner
            const { data: bookings, error: bErr } = await db.from('bookings')
                .select(`id, service_type, scheduled_date, scheduled_time, status, provider_id,
                    properties(name, city, lat, lng)`)
                .eq('owner_id', app.currentUser.id)
                .or('status.eq.in_progress,status.eq.confirmed,status.eq.pending')
                .order('scheduled_date', { ascending: false })
                .limit(10);

            if (bErr) { console.error('Live Worksite bookings error:', bErr); return; }

            if (!bookings || bookings.length === 0) {
                el.innerHTML = `<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px;">
                    <div style="font-size:32px;margin-bottom:10px;">🏠</div>
                    No active visits today — all quiet on the worksite.
                </div>`;
                return;
            }

            const bookingIds = bookings.map(b => b.id);
            const providerIds = [...new Set(bookings.map(b => b.provider_id).filter(Boolean))];

            // Fetch check-ins and profiles in parallel
            const [{ data: provCheckins }, { data: workerCheckins }, { data: provProfiles }] = await Promise.all([
                db.from('visit_reports')
                    .select('booking_id, checked_in_at, checked_out_at, inside_geofence')
                    .in('booking_id', bookingIds)
                    .not('checked_in_at', 'is', null),
                db.from('worker_checkins')
                    .select('booking_id, check_in_time, check_out_time, inside_geofence, worker_id')
                    .in('booking_id', bookingIds),
                db.from('profiles').select('id, first_name, last_name').in('id', providerIds)
            ]);

            // Index data
            const provMap = {};
            (provCheckins || []).forEach(c => { provMap[c.booking_id] = c; });

            const workerMap = {};
            (workerCheckins || []).forEach(c => {
                if (!workerMap[c.booking_id]) workerMap[c.booking_id] = [];
                workerMap[c.booking_id].push(c);
            });

            const profMap = {};
            (provProfiles || []).forEach(p => profMap[p.id] = p);

            // Fetch worker names from provider_workers (Field Workers)
            const allWorkerIds = [...new Set((workerCheckins || []).map(wc => wc.worker_id))];
            const workerProfilesMap = {};
            if (allWorkerIds.length) {
                const { data: wp } = await db.from('provider_workers').select('id, first_name, last_name').in('id', allWorkerIds);
                (wp || []).forEach(p => workerProfilesMap[p.id] = p);
            }

            const statusDot = (inside, checkedOut) => {
                if (checkedOut) return `<span style="color:var(--muted);font-size:12px;">◼ Left site</span>`;
                if (inside === true) return `<span style="display:inline-flex;align-items:center;gap:5px;color:var(--success);font-size:12px;font-weight:600;"><span class="pulse-dot green"></span>On Site</span>`;
                if (inside === false) return `<span style="display:inline-flex;align-items:center;gap:5px;color:var(--warn);font-size:12px;font-weight:600;"><span class="pulse-dot orange"></span>Outside Fence</span>`;
                return `<span style="color:var(--muted);font-size:12px;">⏳ Not checked in</span>`;
            };

            el.innerHTML = `
                <table class="live-worksite-table">
                    <thead>
                        <tr>
                            <th>Property</th>
                            <th>Service</th>
                            <th>Provider</th>
                            <th>Workers</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${bookings.map(b => {
                const prov = provMap[b.id];
                const workers = workerMap[b.id] || [];
                const profile = profMap[b.provider_id] || {};
                const provName = profile.first_name ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : '—';

                const workerStatus = workers.length > 0
                    ? workers.map(w => {
                        const wp = workerProfilesMap[w.worker_id] || {};
                        const wn = wp.first_name ? `${wp.first_name} ${wp.last_name || ''}`.trim() : 'Worker';
                        return `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
                                        ${statusDot(w.inside_geofence, w.check_out_time)}
                                        <span style="font-size:12px;color:var(--ink);">${app.esc(wn)}</span>
                                    </div>`;
                    }).join('')
                    : '<span style="color:var(--muted);font-size:12px;">No workers checked in</span>';

                return `<tr>
                                <td>
                                    <div style="font-weight:500;color:var(--ink);">${app.esc(b.properties?.name || '—')}</div>
                                    <div style="font-size:11px;color:var(--muted);">${app.esc(b.properties?.city || '')}</div>
                                </td>
                                <td><span class="service-tag">${app.esc(b.service_type)}</span></td>
                                <td>
                                    <div style="font-weight:500;font-size:13px;">${app.esc(provName)}</div>
                                    <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
                                        ${statusDot(prov?.inside_geofence, prov?.checked_out_at)}
                                        ${prov?.checked_in_at ? `<div style="font-size:11px;color:var(--muted);">since ${new Date(prov.checked_in_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
                                    </div>
                                </td>
                                <td style="background:var(--cream-light);">${workerStatus}</td>
                                <td style="text-align:right;">
                                    <button class="btn-as" style="padding:6px 12px;font-size:11px;" onclick="app.openMonitorModal('${b.id}')">🛰️ Track</button>
                                </td>
                            </tr>`;
            }).join('')}
                    </tbody>
                </table>
            `;
        },
        async loadProperties() {
            const { data: props } = await db.from('properties').select('id,name,city,state,lat,lng,geofence_radius,property_type').eq('owner_id', app.currentUser.id).or('is_active.is.null,is_active.eq.true').limit(3);
            const el = document.getElementById('propCards');
            if (!el) return;
            if (!props?.length) { el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;">No properties</div>`; return; }
            el.innerHTML = props.map(p => `
                <div class="prop-item">
                    <div class="prop-thumb">🏠</div>
                    <div style="flex:1;min-width:0;">
                        <div class="prop-name">${app.esc(p.name)}</div>
                        <div class="prop-loc">${app.esc(p.city)} · 📍${p.geofence_radius}m</div>
                    </div>
                    <div class="prop-status">${app.esc(p.property_type || 'Property')}</div>
                </div>
            `).join('');
        },
        async loadAlerts() {
            const { data } = await db.from('alerts').select('*').eq('owner_id', app.currentUser.id).order('created_at', { ascending: false }).limit(4);
            const el = document.getElementById('alertsCards');
            if (!el) return;
            if (!data || data.length === 0) { el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;">No alerts</div>`; return; }
            el.innerHTML = data.map(a => `
                <div class="alert-item ${a.is_read ? '' : 'unread'}" style="padding:10px 0;border-bottom:1px solid var(--border);">
                    <div style="font-size:13px;font-weight:500;">${app.esc(a.title || 'Alert')}</div>
                    <div style="font-size:12px;color:var(--muted);">${new Date(a.created_at).toLocaleDateString()}</div>
                </div>
            `).join('');
        }
    },

    properties: {
        async load() {
            const { data } = await db.from('properties').select('*').eq('owner_id', app.currentUser.id).order('created_at', { ascending: false });
            // Removed (archived) properties keep their history but are listed separately.
            app.properties.archived = (data || []).filter(p => p.is_active === false);
            app.properties.data = (data || []).filter(p => p.is_active !== false);
            if (document.getElementById('propCountLabel')) document.getElementById('propCountLabel').textContent = `You have ${app.properties.data.length} properties registered.`;
            app.properties.renderArchived();
            const grid = document.getElementById('propGrid');
            if (!grid) return;
            if (app.properties.data.length === 0) {
                grid.innerHTML = `
                    <div style="grid-column:1/-1;text-align:center;padding:60px;background:var(--white);border-radius:12px;border:1px dashed var(--border);">
                        <p style="font-size:15px;color:var(--muted);margin-bottom:16px;">You haven't added any properties yet.</p>
                        <button class="btn-primary" onclick="app.openAddPropertyModal()">+ Add Property</button>
                    </div>
                `;
                return;
            }
            grid.innerHTML = app.properties.data.map(p => `
                <div class="prop-card-full">
                    <div class="prop-card-map">
                        ${p.photo_url
                            ? `<img class="prop-card-photo" src="${app.esc(p.photo_url)}" alt="${app.esc(p.name)}" loading="lazy">`
                            : (p.lat != null && p.lng != null)
                                ? `<div class="prop-card-minimap" id="pmap-${app.esc(p.id)}"></div>`
                                : `<div style="height:100%;background:var(--sage-pale);display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--sage);opacity:0.3;">🗺️</div>`}
                        <div class="prop-photo-actions">
                            <button class="prop-photo-btn" onclick="app.properties.pickPhoto('${app.esc(p.id)}')">📷 ${p.photo_url ? 'Change photo' : 'Add photo'}</button>
                            ${p.photo_url ? `<button class="prop-photo-btn" style="color:var(--error);" onclick="app.properties.removePhoto('${app.esc(p.id)}')">Remove photo</button>` : ''}
                        </div>
                    </div>
                    <div class="prop-card-body">
                        <div class="prop-card-top">
                            <div class="prop-card-name">${app.esc(p.name)}</div>
                            <span class="prop-tag">${app.esc(p.property_type || 'House')}</span>
                        </div>
                        <div class="prop-card-loc">${app.esc(p.city)}, ${app.esc(p.state || 'Kerala')}</div>
                        <div id="wx-${p.id}" class="prop-card-weather">Loading weather...</div>
                        <div class="prop-card-fence">📍 Geo-fence: ${p.geofence_radius || 200}m radius</div>
                        <div class="prop-card-actions">
                            <button class="btn-primary" onclick="app.openBookingModal('${p.id}')">Book Visit</button>
                            <button class="btn-ghost" style="color:var(--error);" onclick="app.properties.removeProperty('${p.id}')">Remove</button>
                        </div>
                    </div>
                </div>
            `).join('');

            app.properties.renderMiniMaps();

            app.properties.data.forEach(p => {
                if (p.lat && p.lng) {
                    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lng}&current=temperature_2m,weathercode&timezone=Asia%2FKolkata`)
                        .then(r => r.json()).then(wx => {
                            const el = document.getElementById('wx-' + p.id);
                            if (el && wx.current) {
                                el.innerHTML = `🌡️ ${wx.current.temperature_2m}°C currently at property`;
                            }
                        }).catch(() => { });
                }
            });
        },
        async saveProperty() {
            const name = document.getElementById('propName').value.trim();
            const city = document.getElementById('propCity').value.trim();
            const district = document.getElementById('propDistrict').value;
            const typeChoice = document.getElementById('propType').value;
            const typeOther = (document.getElementById('propTypeOther')?.value || '').trim();
            const type = typeChoice === 'Other' ? (typeOther || 'Other') : typeChoice;
            const notes = document.getElementById('propNotes').value;
            const lat = document.getElementById('propLat').value;
            const lng = document.getElementById('propLng').value;

            if (!name) { toast('Please enter a property name.', 'error'); return; }
            if (!city) { toast('Please enter a city / town.', 'error'); return; }
            if (!district) { toast('Please select a district.', 'error'); return; }
            if (!lat || !lng) { toast('Please pin the property location on the map.', 'error'); return; }

            const btn = document.getElementById('savePropBtn');
            btn.textContent = 'Saving…'; btn.disabled = true;

            const { data: created, error } = await db.from('properties').insert([{
                owner_id: app.currentUser.id,
                name, city,
                state: district,
                property_type: type,
                lat: parseFloat(lat),
                lng: parseFloat(lng),
                geofence_radius: app.properties.geofenceRadius
            }]).select('id').single();

            if (error) {
                btn.textContent = 'Save Property'; btn.disabled = false;
                toast('Save failed: ' + error.message, 'error');
                return;
            }

            const photoInput = document.getElementById('propPhoto');
            const photo = photoInput?.files?.[0];
            if (photo && created?.id) {
                btn.textContent = 'Uploading photo…';
                const url = await app.properties.uploadPhoto(created.id, photo);
                if (!url) toast('Property saved, but the photo was not. Use "Add photo" on its card.', 'error');
            }
            if (photoInput) photoInput.value = '';
            btn.textContent = 'Save Property'; btn.disabled = false;

            if (!photo) toast('Property added successfully ✓', 'success');
            else toast('Property and photo saved ✓', 'success');
            app.closeAddPropertyModal();
            app.properties.load();
        },
        // Small, non-interactive map of the pin and geo-fence for cards without a photo.
        renderMiniMaps() {
            (app.properties.cardMaps || []).forEach(m => m.remove());
            app.properties.cardMaps = [];
            app.properties.data.forEach(p => {
                const el = document.getElementById('pmap-' + p.id);
                if (!el || p.photo_url) return;
                const map = L.map(el, {
                    zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
                    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false
                }).setView([p.lat, p.lng], 16);
                L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
                const fence = L.circle([p.lat, p.lng], { radius: p.geofence_radius || 200, color: '#16a34a', weight: 2, fillOpacity: 0.15, interactive: false }).addTo(map);
                L.circleMarker([p.lat, p.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#2d5a3d', fillOpacity: 1, interactive: false }).addTo(map);
                const fit = () => { map.invalidateSize(); map.fitBounds(fence.getBounds(), { padding: [12, 12] }); };
                setTimeout(fit, 50);
                app.properties.cardMaps.push(map);
            });
        },
        pickPhoto(propId) {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) return;
                const url = await app.properties.uploadPhoto(propId, file);
                if (url) { toast('Photo saved ✓', 'success'); app.properties.load(); }
            };
            input.click();
        },
        async removePhoto(propId) {
            const prop = (app.properties.data || []).find(p => p.id === propId);
            if (!prop?.photo_url) return;
            if (!await confirmDialog(`Remove the photo of "${prop.name}"? The card will show its map instead.`, { okLabel: 'Remove photo', danger: true })) return;
            const { error } = await db.from('properties').update({ photo_url: null })
                .eq('id', propId).eq('owner_id', app.currentUser.id);
            if (error) { toast('Could not remove the photo: ' + error.message, 'error'); return; }
            // Best effort: delete the stored file too (only works inside the owner's own folder).
            const marker = '/property-photos/';
            const at = prop.photo_url.indexOf(marker);
            if (at !== -1) {
                const path = decodeURIComponent(prop.photo_url.slice(at + marker.length).split('?')[0]);
                const { error: rmErr } = await db.storage.from('property-photos').remove([path]);
                if (rmErr) console.warn('Photo file was not deleted from storage:', rmErr.message);
            }
            toast('Photo removed ✓', 'success');
            app.properties.load();
        },
        // Uploads to property-photos/<owner id>/... and stores the public URL on the property.
        async uploadPhoto(propId, file) {
            if (!file.type.startsWith('image/')) { toast('Please choose an image file.', 'error'); return null; }
            if (file.size > 5 * 1024 * 1024) { toast('Photo is too large (max 5 MB).', 'error'); return null; }
            toast('Uploading photo…', 'success');
            const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
            const path = `${app.currentUser.id}/${propId}-${Date.now()}.${ext}`;
            const { error: upErr } = await db.storage.from('property-photos').upload(path, file, { contentType: file.type });
            if (upErr) { toast('Photo upload failed: ' + upErr.message, 'error'); return null; }
            const { data: pub } = db.storage.from('property-photos').getPublicUrl(path);
            const { error } = await db.from('properties').update({ photo_url: pub.publicUrl })
                .eq('id', propId).eq('owner_id', app.currentUser.id);
            if (error) { toast('Could not save the photo: ' + error.message, 'error'); return null; }
            return pub.publicUrl;
        },
        // Removing a property:
        //  - upcoming / in-progress visits → refuse (cancel them first);
        //  - past bookings → archive (is_active = false) so bookings, reports and
        //    payments are kept; it can be restored later;
        //  - no bookings at all → delete permanently.
        // A real DELETE cascades to bookings, payments and reports, so it is never
        // used for a property that has history.
        async removeProperty(id) {
            const prop = (app.properties.data || []).find(p => p.id === id);
            const name = prop?.name || 'this property';
            const [all, open] = await Promise.all([
                db.from('bookings').select('id', { count: 'exact', head: true }).eq('property_id', id),
                db.from('bookings').select('id', { count: 'exact', head: true }).eq('property_id', id)
                    .in('status', ['pending', 'confirmed', 'in_progress'])
            ]);
            const err = all.error || open.error;
            if (err || all.count == null || open.count == null) {
                toast('Could not check this property\'s bookings' + (err ? ': ' + err.message : '') + '. Nothing was removed.', 'error');
                return;
            }
            if (open.count > 0) {
                toast(`"${name}" has ${open.count} upcoming or in-progress visit${open.count === 1 ? '' : 's'}. Cancel or finish ${open.count === 1 ? 'it' : 'them'} before removing the property.`, 'error');
                return;
            }
            if (all.count > 0) {
                const ok = await confirmDialog(
                    `Remove "${name}"?\n\n` +
                    `Its history will NOT be deleted: all ${all.count} past booking${all.count === 1 ? '' : 's'}, visit reports and payments stay in Bookings and Reports.\n\n` +
                    `The property will be hidden and can't be booked. You can restore it any time from "Removed properties" at the bottom of this page.`,
                    { okLabel: 'Remove, keep history', danger: true });
                if (!ok) return;
                const { error } = await db.from('properties').update({ is_active: false })
                    .eq('id', id).eq('owner_id', app.currentUser.id);
                if (error) { toast('Could not remove property: ' + error.message, 'error'); return; }
                toast(`"${name}" removed. Its history is kept, and you can restore it below.`, 'success');
                app.properties.load();
                return;
            }
            if (!await confirmDialog(`Remove "${name}"?\n\nIt has no bookings or history, so it will be deleted permanently. This cannot be undone.`, { okLabel: 'Delete permanently', danger: true })) return;
            const { error } = await db.from('properties').delete().eq('id', id).eq('owner_id', app.currentUser.id);
            if (error) { toast('Could not remove property: ' + error.message, 'error'); return; }
            toast(`"${name}" deleted.`, 'success');
            app.properties.load();
        },
        async restoreProperty(id) {
            const prop = (app.properties.archived || []).find(p => p.id === id);
            const { error } = await db.from('properties').update({ is_active: true })
                .eq('id', id).eq('owner_id', app.currentUser.id);
            if (error) { toast('Could not restore property: ' + error.message, 'error'); return; }
            toast(`"${prop?.name || 'Property'}" restored ✓`, 'success');
            app.properties.load();
        },
        renderArchived() {
            const el = document.getElementById('archivedProps');
            if (!el) return;
            const list = app.properties.archived || [];
            if (!list.length) { el.innerHTML = ''; return; }
            el.innerHTML = `
                <details class="archived-props">
                    <summary>Removed properties (${list.length}) — history kept</summary>
                    ${list.map(p => `
                        <div class="archived-row">
                            <div>
                                <div style="font-weight:500;color:var(--ink);">${app.esc(p.name)}</div>
                                <div style="font-size:12px;color:var(--muted);">${app.esc(p.city || '')}${p.state ? ', ' + app.esc(p.state) : ''} · bookings and reports kept</div>
                            </div>
                            <button class="btn-ghost" onclick="app.properties.restoreProperty('${app.esc(p.id)}')">Restore</button>
                        </div>`).join('')}
                </details>`;
        },
        // ── Place search with live suggestions ─────────────────────────
        // Photon (OpenStreetMap data) is built for search-as-you-type; Nominatim's
        // usage policy forbids client-side autocomplete. Results favour Kerala.
        async placeSearch(q) {
            const base = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lang=en&lat=10.3&lon=76.4`;
            const toPlaces = j => (j.features || []).map(f => {
                const pr = f.properties || {};
                const [lng, lat] = f.geometry.coordinates;
                const parts = [pr.street && pr.housenumber ? `${pr.housenumber} ${pr.street}` : pr.street,
                    pr.city || pr.town || pr.village, pr.county, pr.state].filter(Boolean);
                const sub = [...new Set(parts)].filter(x => x !== pr.name).join(', ');
                return { name: pr.name || parts[0] || q, sub, lat, lng, kind: pr.osm_value || pr.type || '',
                    city: pr.city || pr.town || pr.village || (['village', 'town', 'city', 'hamlet', 'suburb'].includes(pr.osm_value) ? pr.name : ''),
                    district: pr.county || '' };
            });
            let places = toPlaces(await (await fetch(base + '&bbox=74.8,8.1,77.6,12.9')).json());
            if (!places.length) places = toPlaces(await (await fetch(base)).json());
            return places;
        },
        suggest(q) {
            clearTimeout(app.properties._suggestTimer);
            const box = document.getElementById('mapSuggest');
            if (!q || q.trim().length < 3) { app.properties.hideSuggestions(); return; }
            app.properties._suggestTimer = setTimeout(async () => {
                const seq = (app.properties._suggestSeq = (app.properties._suggestSeq || 0) + 1);
                let places = [];
                try { places = await app.properties.placeSearch(q.trim()); }
                catch (e) { console.warn('Place search failed:', e); }
                if (seq !== app.properties._suggestSeq) return; // a newer search replaced this one
                app.properties.suggestions = places;
                app.properties.suggestIdx = -1;
                box.innerHTML = places.length
                    ? places.map((p, i) => `<div class="map-suggest-item" role="option" data-i="${i}"
                            onmousedown="event.preventDefault();app.properties.chooseSuggestion(${i})">
                            <div>${app.esc(p.name)}</div><div class="map-suggest-sub">${app.esc(p.sub)}</div></div>`).join('')
                    : `<div class="map-suggest-empty">No matches. Try a nearby town or landmark, or click the map.</div>`;
                box.hidden = false;
                document.getElementById('mapSearch').setAttribute('aria-expanded', 'true');
            }, 300);
        },
        hideSuggestions() {
            const box = document.getElementById('mapSuggest');
            if (box) { box.hidden = true; box.innerHTML = ''; }
            document.getElementById('mapSearch')?.setAttribute('aria-expanded', 'false');
        },
        onSearchKey(e) {
            const items = [...document.querySelectorAll('#mapSuggest .map-suggest-item')];
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (!items.length) return;
                e.preventDefault();
                const n = items.length, cur = app.properties.suggestIdx ?? -1;
                app.properties.suggestIdx = e.key === 'ArrowDown' ? (cur + 1) % n : (cur - 1 + n) % n;
                items.forEach((el, i) => el.classList.toggle('active', i === app.properties.suggestIdx));
                items[app.properties.suggestIdx].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (items.length) app.properties.chooseSuggestion(Math.max(0, app.properties.suggestIdx ?? 0));
                else app.properties.searchMap();
            } else if (e.key === 'Escape') {
                app.properties.hideSuggestions();
            }
        },
        chooseSuggestion(i) {
            const p = (app.properties.suggestions || [])[i];
            if (!p) return;
            app.properties.hideSuggestions();
            document.getElementById('mapSearch').value = p.sub ? `${p.name}, ${p.sub}` : p.name;
            const zoom = ['village', 'town', 'city', 'suburb', 'local_authority', 'county'].includes(p.kind) ? 15 : 18;
            app.properties.placePin(p.lat, p.lng, false);
            app.properties.mapPicker.setView([p.lat, p.lng], zoom);
            const cityEl = document.getElementById('propCity');
            if (p.city && cityEl && !cityEl.value.trim()) cityEl.value = p.city;
            if (p.district) app.properties.selectDistrict(p.district);
            toast('Pin placed. Click the map to move it to the exact spot.', 'success');
        },
        selectDistrict(name) {
            const sel = document.getElementById('propDistrict');
            if (!sel || !name) return;
            const n = name.toLowerCase();
            const opt = [...sel.options].find(o => o.value && (n.includes(o.value.toLowerCase()) || o.value.toLowerCase().includes(n)));
            if (opt) sel.value = opt.value;
        },
        async searchMap() {
            const q = document.getElementById('mapSearch').value.trim();
            if (!q) return;
            try {
                const places = await app.properties.placeSearch(q);
                if (!places.length) { toast('Location not found. Try a nearby town or landmark, or click the map.', 'error'); return; }
                app.properties.suggestions = places;
                app.properties.chooseSuggestion(0);
            } catch (e) {
                toast('Search service unavailable. Click the map to place the pin.', 'error');
            }
        },
        locateMe() {
            if (!navigator.geolocation) { alert('Geolocation not supported.'); return; }
            const btn = document.getElementById('btnLocateMe');
            const originalText = btn.textContent;
            btn.textContent = '🛰️ Finding you...';
            btn.disabled = true;

            navigator.geolocation.getCurrentPosition(pos => {
                btn.textContent = originalText;
                btn.disabled = false;
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                app.properties.placePin(lat, lng, true);
                app.properties.mapPicker.setView([lat, lng], 18);
            }, err => {
                btn.textContent = originalText;
                btn.disabled = false;
                alert('GPS Error: ' + err.message + '. Please ensure location is enabled.');
            }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
        },
        setMapType(type) {
            const layers = app.properties.layers;
            if (type === 'sat') {
                app.properties.mapPicker.removeLayer(layers.street);
                layers.sat.addTo(app.properties.mapPicker);
                document.getElementById('btnTypeSat').classList.add('active');
                document.getElementById('btnTypeStreet').classList.remove('active');
            } else {
                app.properties.mapPicker.removeLayer(layers.sat);
                layers.street.addTo(app.properties.mapPicker);
                document.getElementById('btnTypeStreet').classList.add('active');
                document.getElementById('btnTypeSat').classList.remove('active');
            }
        },
        async reverseGeocode(lat, lng) {
            try {
                const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
                const data = await r.json();
                if (data && data.address) {
                    const addr = data.address;
                    const city = addr.city || addr.town || addr.village || addr.suburb || '';
                    const district = addr.state_district || addr.county || '';
                    if (city) document.getElementById('propCity').value = city;
                    if (district) {
                        const sel = document.getElementById('propDistrict');
                        for (let i = 0; i < sel.options.length; i++) {
                            if (district.toLowerCase().includes(sel.options[i].value.toLowerCase())) {
                                sel.selectedIndex = i; break;
                            }
                        }
                    }
                }
            } catch (e) { console.error('Geocode error', e); }
        },
        updateRadius(val) {
            app.properties.geofenceRadius = parseInt(val);
            document.getElementById('radiusDisplay').textContent = val + ' m';
            if (app.properties.mapCircle && app.properties.mapMarker) {
                app.properties.mapCircle.setRadius(app.properties.geofenceRadius);
            }
        },
        placePin(lat, lng, shouldGeocode = false) {
            console.log('Placing pin at:', lat, lng, 'with radius:', app.properties.geofenceRadius);
            document.getElementById('propLat').value = lat;
            document.getElementById('propLng').value = lng;

            if (app.properties.mapMarker) app.properties.mapPicker.removeLayer(app.properties.mapMarker);
            if (app.properties.mapCircle) app.properties.mapPicker.removeLayer(app.properties.mapCircle);

            const pulseIcon = L.divIcon({ className: 'gps-pulse-wrapper', html: '<div class="gps-pulse"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });
            app.properties.mapMarker = L.marker([lat, lng], { icon: pulseIcon }).addTo(app.properties.mapPicker);

            const radius = parseFloat(app.properties.geofenceRadius) || 200;
            app.properties.mapCircle = L.circle([lat, lng], {
                radius: radius,
                color: '#16a34a',
                weight: 3,
                fillColor: '#16a34a',
                fillOpacity: 0.3,
                interactive: false
            }).addTo(app.properties.mapPicker);

            if (shouldGeocode) app.properties.reverseGeocode(lat, lng);
        }
    },

    bookings: {
        async load() {
            const tbody = document.getElementById('bookingsTbody');
            if (!tbody) return;
            tbody.innerHTML = `<tr><td colspan="6"><div class="loading-row"><div class="spinner"></div>Loading...</div></td></tr>`;

            const { data } = await db.from('bookings').select('*, properties(name)').eq('owner_id', app.currentUser.id).order('scheduled_date', { ascending: false });
            const bookingsList = data || [];

            // Fetch payments for these bookings
            const bIds = bookingsList.map(b => b.id);
            let payMap = {};
            if (bIds.length) {
                const { data: pays } = await db.from('payments').select('*').in('booking_id', bIds);
                (pays || []).forEach(p => { payMap[p.booking_id] = p; });
            }
            app.bookings.data = bookingsList.map(b => ({ ...b, _payment: payMap[b.id] || null }));

            if (app.bookings.data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted);">No bookings yet. <a href="#" onclick="app.openBookingModal()">Book one now</a></td></tr>`;
                return;
            }
            tbody.innerHTML = app.bookings.data.map(b => {
                // Booking amount includes the provider's price and the platform commission.
                const price = b.amount ? Math.round(b.amount / 100) : (app.SERVICE_PRICES[b.service_type] || 0);
                const pm = (b._payment);
                let payBadge = '';
                if (pm) {
                    if (pm.status === 'paid') payBadge = `<span title="Held by Tender Touch until the visit is completed and verified" style="font-size:11px;padding:3px 9px;border-radius:12px;background:rgba(22,163,74,.08);color:var(--success);font-weight:500;">🔒 Paid ₹${(pm.amount/100).toLocaleString('en-IN')} · held</span>`;
                    else if (pm.status === 'released') payBadge = `<span style="font-size:11px;padding:3px 9px;border-radius:12px;background:rgba(45,90,61,.1);color:var(--sage);font-weight:500;">💰 Released ₹${(pm.amount/100).toLocaleString('en-IN')}</span>`;
                    else if (pm.status === 'refunded') payBadge = `<span style="font-size:11px;padding:3px 9px;border-radius:12px;background:rgba(107,114,128,.08);color:var(--muted);font-weight:500;">↩ Refunded</span>`;
                    else if (b.status === 'cancelled') payBadge = `<span style="font-size:11px;color:var(--muted);">Not charged</span>`;
                    else payBadge = `<button class="btn-ghost" style="font-size:11px;padding:4px 10px;color:var(--sage);border:1px solid var(--sage);" onclick="app.payExistingBooking('${app.esc(b.id)}')">💳 Pay ₹${(pm.amount/100).toLocaleString('en-IN')}</button>`;
                } else if (b.status === 'pending' && price) {
                    payBadge = `<button class="btn-ghost" style="font-size:11px;padding:4px 10px;color:var(--sage);border:1px solid var(--sage);" onclick="app.payExistingBooking('${app.esc(b.id)}')">💳 Pay ₹${price.toLocaleString('en-IN')}</button>`;
                } else if (price) {
                    payBadge = `<span style="font-size:11px;color:var(--muted);">₹${price.toLocaleString('en-IN')}</span>`;
                }
                return `<tr>
                <td><strong>${app.esc(b.properties?.name || '—')}</strong></td>
                <td>${app.esc(b.service_type || '—')}</td>
                <td>${app.esc(formatBookingDateTime(b.scheduled_date, b.scheduled_time) || '—')}</td>
                <td><span class="status-badge ${app.esc(b.status || 'pending')}">${app.esc((b.status || 'pending').replace('_', ' '))}</span></td>
                <td>${payBadge}</td>
                <td>
                    <div style="display:flex;gap:5px;align-items:center;">
                        ${app.dashboard.qaLabel(b.status, b.id)}
                        ${['pending', 'confirmed'].includes(b.status) ? `<button class="btn-ghost" style="font-size:11px;padding:4px 10px;color:var(--error);" onclick="app.bookings.cancelBooking('${b.id}')">Cancel</button>` : ''}
                    </div>
                </td>
            </tr>`;
            }).join('');
        },
        async loadInspectors() {
            const { data, error } = await db.from('profiles')
                .select('id, first_name, last_name')
                .eq('role', 'qa_inspector');
            if (error) console.error('loadInspectors error:', error.message);
            app.bookings.inspectors = data || [];
            const sel = document.getElementById('qaInspectorSelect');
            if (sel) {
                if (!app.bookings.inspectors.length) {
                    sel.innerHTML = `<option value="">No QA inspectors found — ask admin to promote a user</option>`;
                } else {
                    sel.innerHTML = '<option value="">Select inspector…</option>' +
                        app.bookings.inspectors.map(i => `<option value="${app.esc(i.id)}">${app.esc(i.first_name || '')} ${app.esc(i.last_name || '')}</option>`).join('');
                }
            }
        },
        async loadPropertiesAndProvidersForModal() {
            const [{ data: props, error: pErr }, { data: provs, error: rErr }] = await Promise.all([
                db.from('properties').select('id,name,city').eq('owner_id', app.currentUser.id).or('is_active.is.null,is_active.eq.true'),
                db.from('profiles').select('id,first_name,last_name,phone,city,bio,experience_years,rating,completed_jobs,avatar_url').eq('role', 'provider')
            ]);
            // Only services a provider lists can be booked; providers without any are not shown.
            const [{ data: services, error: sErr }, { data: setting }] = await Promise.all([
                db.from('provider_services').select('provider_id,service_type,price_paise,description').eq('is_active', true).order('service_type'),
                db.from('platform_settings').select('value').eq('key', 'commission_percent').maybeSingle()
            ]);
            if (sErr) console.error('Services error:', sErr.message);
            app.commissionPercent = setting?.value != null ? Number(setting.value) : 10;
            app.servicesByProvider = {};
            (services || []).forEach(s => { (app.servicesByProvider[s.provider_id] ||= []).push(s); });

            if (pErr) console.error('Properties error:', pErr.message);
            if (rErr) console.error('Providers error:', rErr.message);
            
            app.allProperties = props || [];
            app.allProviders = (provs || []).filter(p => app.servicesByProvider[p.id]?.length);

            document.getElementById('bookPropSelect').innerHTML =
                '<option value="">Select property…</option>' +
                app.allProperties.map(p => `<option value="${app.esc(p.id)}">${app.esc(p.name)} ${p.city ? '(' + app.esc(p.city) + ')' : ''}</option>`).join('');

            // Set up onchange for property select to filter providers
            document.getElementById('bookPropSelect').onchange = () => app.filterProvidersByProperty();
            document.getElementById('bookProvider').onchange = () => { app.populateServices(); app.updatePricePreview(); };

            app.filterProvidersByProperty();
        },
        async saveBooking() {
            const propId = document.getElementById('bookPropSelect').value;
            const type = document.getElementById('bookService').value;
            const date = document.getElementById('bookDate').value;
            const time = document.getElementById('bookTime').value;
            const provId = document.getElementById('bookProvider').value;
            const notes = document.getElementById('bookNotes').value;

            if (!propId) { toast('Please select a property.', 'error'); return; }
            if (!provId) { toast('Please select a service provider.', 'error'); return; }
            if (!type) { toast('Please choose one of the provider\'s services.', 'error'); return; }
            if (!date || !time) { toast('Please choose a date and time.', 'error'); return; }
            if (!isValidBookingDateTime(date, time)) { toast('Choose a future available slot between 8:00 AM and 5:30 PM IST, with 1 hour notice for today.', 'error'); return; }
            if (!provId) { toast('Please select a service provider.', 'error'); return; }

            // Price comes from the server: provider's price + platform commission (paise).
            const quote = await app.getQuote(provId, type);
            if (!quote) { toast('Could not get the price for this service. Try again.', 'error'); return; }
            const amount = quote.total_paise;

            // Store form data temporarily and open payment modal
            app.pendingBookingData = { propId, type, date, time, provId, notes, amount };
            app.openPaymentModal(type, amount);
        },
        async cancelBooking(bookingId) {
            if (!await confirmDialog('Cancel this booking? A paid booking is refunded automatically.', { okLabel: 'Cancel booking', danger: true })) return;

            const { error } = await db.from('bookings').update({ status: 'cancelled' }).eq('id', bookingId);
            if (error) {
                toast('Failed to cancel: ' + error.message, 'error');
                return;
            }

            // Auto-refund if paid
            const { data: payment } = await db.from('payments').select('*').eq('booking_id', bookingId).maybeSingle();
            if (payment && payment.status === 'paid') {
                const { error: refundErr } = await db.from('payments').update({
                    status: 'refunded',
                    refunded_at: new Date().toISOString()
                }).eq('booking_id', bookingId);
                if (refundErr) toast('Booking cancelled, but the refund could not be recorded: ' + refundErr.message, 'error');
                else toast(`Booking cancelled. ₹${(payment.amount / 100).toLocaleString('en-IN')} refunded. ✓`, 'success');
            } else {
                toast('Booking cancelled ✓', 'success');
            }
            // Refresh whatever view we are on
            if (window.location.hash === '#dashboard' || !window.location.hash) app.dashboard.loadRecentBookings();
            if (window.location.hash === '#bookings') app.bookings.load();
        }
    },

    filterProvidersByProperty() {
        const propId = document.getElementById('bookPropSelect').value;
        const prop = (app.allProperties || []).find(p => p.id === propId);
        const propCity = prop?.city || null;

        let filtered = app.allProviders || [];
        if (propCity) {
            filtered = [...filtered].sort((a, b) => {
                if (a.city === propCity && b.city !== propCity) return -1;
                if (a.city !== propCity && b.city === propCity) return 1;
                return 0;
            });
        }

        const sel = document.getElementById('bookProvider');
        if (!filtered.length) {
            sel.innerHTML = `<option value="">No providers have listed services yet</option>`;
            app.populateServices();
            return;
        }

        sel.innerHTML = `<option value="">Select provider…</option>` + filtered.map(p => {
            let label = `${p.first_name || ''} ${p.last_name || ''}`;
            if (propCity && p.city === propCity) label += ` (Nearest — ${p.city})`;
            else if (p.city) label += ` (${p.city})`;
            return `<option value="${app.esc(p.id)}">${app.esc(label)}</option>`;
        }).join('');
        app.populateServices();
        app.updatePricePreview();
    },

    // Fill the service list with what the chosen provider offers (owner price incl. platform fee).
    populateServices() {
        const sel = document.getElementById('bookService');
        if (!sel) return;
        const provId = document.getElementById('bookProvider')?.value;
        const list = (app.servicesByProvider || {})[provId] || [];
        if (!provId || !list.length) {
            sel.innerHTML = `<option value="">${provId ? 'This provider has no services listed' : 'Choose a provider first'}</option>`;
            sel.disabled = true;
            return;
        }
        const pct = app.commissionPercent ?? 10;
        const previous = sel.value;
        sel.innerHTML = list.map(s => {
            const total = s.price_paise + Math.round(s.price_paise * pct / 100);
            return `<option value="${app.esc(s.service_type)}">${app.esc(s.service_type)} — ₹${Math.round(total / 100).toLocaleString('en-IN')}</option>`;
        }).join('');
        sel.disabled = false;
        if (list.some(s => s.service_type === previous)) sel.value = previous;
    },

    async openProviderPortfolio() {
        const provId = document.getElementById('bookProvider').value;
        if (!provId) {
            toast('Please select a provider from the dropdown first', 'error');
            return;
        }
        const p = (app.allProviders || []).find(x => x.id === provId);
        if (!p) return;

        document.getElementById('portName').textContent = `${p.first_name || ''} ${p.last_name || ''}`;
        document.getElementById('portCity').textContent = `📍 ${p.city || 'Anywhere'}`;
        document.getElementById('portRating').textContent = `⭐ ${p.rating || '5.0'}`;
        document.getElementById('portJobs').textContent = p.completed_jobs || 0;
        document.getElementById('portExp').textContent = `${p.experience_years || 0} Yrs`;
        document.getElementById('portBio').textContent = p.bio || 'Experienced and reliable professional ready to take care of your property requirements.';
        app.loadProviderPrices(provId);
        // Provider's own photo/logo if set; otherwise the generic avatar (no names sent to third parties).
        const avatarEl = document.getElementById('portAvatar');
        if (avatarEl) avatarEl.src = p.avatar_url || 'https://ui-avatars.com/api/?name=Provider&background=random';
        const phoneEl = document.getElementById('portPhone');
        if (phoneEl) phoneEl.textContent = p.phone || 'Available upon booking';

        document.getElementById('portfolioModal').style.display = 'flex';

        // Fetch real portfolio
        const galleryEl = document.getElementById('portGallery');
        if (galleryEl) {
            galleryEl.innerHTML = '<div style="font-size:13px;color:#6b7280;grid-column:1/-1;">Loading portfolio...</div>';
            const { data, error } = await db.from('provider_portfolio')
                .select('*')
                .eq('provider_id', provId)
                .order('created_at', { ascending: false });

            if (error) {
                console.error('Error fetching portfolio:', error);
                galleryEl.innerHTML = '<div style="font-size:13px;color:var(--danger);grid-column:1/-1;">Failed to load portfolio images.</div>';
            } else if (!data || data.length === 0) {
                galleryEl.innerHTML = '<div style="font-size:13px;color:#6b7280;grid-column:1/-1;background:#f9fafb;padding:12px;border-radius:8px;text-align:center;">This provider hasn\'t uploaded any recent work yet.</div>';
            } else {
                galleryEl.innerHTML = data.map(item => `
                    <div style="background:#e2e8f0;border-radius:8px;overflow:hidden;position:relative;height:100px;">
                        <img src="${esc(item.image_url)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.src='https://via.placeholder.com/400x300?text=Error'">
                        <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.6);color:white;font-size:10px;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(item.title)}">
                            ${esc(item.title)}
                        </div>
                    </div>
                `).join('');
            }
        }
    },

    // Provider's price list as owners pay it (price + platform commission).
    async loadProviderPrices(provId) {
        const el = document.getElementById('portPrices');
        if (!el) return;
        el.innerHTML = '<div style="font-size:13px;color:#6b7280;">Loading prices…</div>';
        const { data } = await db.from('provider_services').select('service_type,description')
            .eq('provider_id', provId).eq('is_active', true).order('service_type');
        if (!data?.length) { el.innerHTML = '<div style="font-size:13px;color:#6b7280;">No services listed yet.</div>'; return; }
        const quotes = await Promise.all(data.map(s => app.getQuote(provId, s.service_type)));
        el.innerHTML = data.map((s, i) => `
            <div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #f1f1ef;font-size:13px;">
                <div><strong>${app.esc(s.service_type)}</strong>${s.description ? `<div style="font-size:11px;color:#6b7280;">${app.esc(s.description)}</div>` : ''}</div>
                <div style="white-space:nowrap;">${quotes[i] ? '₹' + Math.round(quotes[i].total_paise / 100).toLocaleString('en-IN') : '—'}</div>
            </div>`).join('') + '<div style="font-size:11px;color:#6b7280;margin-top:6px;">Prices include the Tender Touch platform fee.</div>';
    },

    closeProviderPortfolio() {
        document.getElementById('portfolioModal').style.display = 'none';
    },

    async openEditProfile() {
        // Fetch current profile from Supabase
        const { data, error } = await db.from('profiles').select('*').eq('id', app.currentUser.id).single();
        if (error) { console.error(error); toast('Failed to load profile', 'error'); return; }
        document.getElementById('ownerEpFirst').value = data?.first_name || '';
        document.getElementById('ownerEpLast').value = data?.last_name || '';
        document.getElementById('ownerEpCity').value = data?.city || '';
        document.getElementById('ownerEpPhone').value = data?.phone || '';
        document.getElementById('ownerEditProfileModal').style.display = 'flex';
    },

    closeEditProfile() {
        document.getElementById('ownerEditProfileModal').style.display = 'none';
    },

    async saveProfile() {
        const first = document.getElementById('ownerEpFirst').value.trim();
        const last = document.getElementById('ownerEpLast').value.trim();
        const city = document.getElementById('ownerEpCity').value.trim();
        const phone = document.getElementById('ownerEpPhone').value.trim();
        if (!first) { toast('First name is required', 'error'); return; }

        const { error } = await db.from('profiles').update({
            first_name: first,
            last_name: last,
            city: city || null,
            phone: phone || null
        }).eq('id', app.currentUser.id);

        if (error) { toast('Failed to save: ' + error.message, 'error'); return; }

        // Update sidebar display
        const name = `${first} ${last}`;
        const avatarEl = document.getElementById('sidebarAvatar');
        const nameEl = document.getElementById('sidebarName');
        if (avatarEl) avatarEl.textContent = first.charAt(0).toUpperCase();
        if (nameEl) nameEl.textContent = name;

        toast('Profile updated successfully ✓', 'success');
        app.closeEditProfile();
    },


    reports: {
        async load() {
            const el = document.getElementById('reportsList');
            if (!el) return;
            el.innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading reports...</div>`;
            const { data: props } = await db.from('properties').select('*').eq('owner_id', app.currentUser.id);
            app.reports.propsMap = {};
            (props || []).forEach(p => app.reports.propsMap[p.id] = p);

            const propIds = Object.keys(app.reports.propsMap);
            let reps = [];
            if (propIds.length) {
                const { data: bookings } = await db.from('bookings')
                    .select('id, property_id, service_type, scheduled_date, scheduled_time, provider_id')
                    .in('property_id', propIds);
                const bookingMap = {};
                (bookings || []).forEach(b => { bookingMap[b.id] = b; });
                const bookingIds = Object.keys(bookingMap);
                if (bookingIds.length) {
                    const { data: reports } = await db.from('visit_reports')
                        .select('*')
                        .in('booking_id', bookingIds)
                        .order('created_at', { ascending: false });
                    const providerIds = [...new Set((reports || []).map(r => r.provider_id).filter(Boolean))];
                    let profileMap = {};
                    if (providerIds.length) {
                        const { data: profiles } = await db.from('profiles').select('id, first_name, last_name').in('id', providerIds);
                        (profiles || []).forEach(p => { profileMap[p.id] = p; });
                    }
                    reps = (reports || []).map(r => {
                        const booking = bookingMap[r.booking_id] || {};
                        return {
                            ...r,
                            property_id: booking.property_id,
                            bookings: booking,
                            profiles: profileMap[r.provider_id] || null
                        };
                    });
                }
            }

            const filterMap = new Set();
            app.reports.data = reps.filter(r => {
                if (app.reports.propsMap[r.property_id]) {
                    filterMap.add(r.property_id);
                    return true;
                }
                return false;
            });

            const propFilter = document.getElementById('filterProp');
            if (propFilter) {
                propFilter.innerHTML = '<option value="">All Properties</option>' +
                    Array.from(filterMap).map(id => `<option value="${app.esc(id)}">${app.esc(app.reports.propsMap[id].name)}</option>`).join('');
            }
            app.reports.applyFilter();
        },
        applyFilter() {
            const pId = document.getElementById('filterProp')?.value;
            const sVal = document.getElementById('filterStatus')?.value;

            let filtered = app.reports.data;
            if (pId) filtered = filtered.filter(r => r.property_id === pId);
            if (sVal === 'pass') filtered = filtered.filter(r => r.inside_geofence === true);
            else if (sVal === 'fail') filtered = filtered.filter(r => r.inside_geofence === false);

            if (document.getElementById('totalCount')) document.getElementById('totalCount').textContent = `${filtered.length} reports`;
            app.reports.render(filtered);
        },
        render(list) {
            const el = document.getElementById('reportsList');
            if (!el) return;
            if (list.length === 0) { el.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);">No reports match your filters.</div>`; return; }

            el.innerHTML = list.map(r => {
                const p = app.reports.propsMap[r.property_id];
                const b = r.bookings;
                const prov = r.profiles;
                const badge = r.inside_geofence ? `<div class="rc-badge pass">✅ Inside Geo-fence</div>` : `<div class="rc-badge fail">❌ Outside Geo-fence</div>`;
                const date = new Date(r.created_at).toLocaleString();

                return `
                <div class="report-card">
                    <div class="rc-hdr" onclick="this.nextElementSibling.classList.toggle('open')">
                        <div style="width:40px;height:40px;border-radius:8px;background:var(--sage-pale);display:flex;align-items:center;justify-content:center;margin-right:16px;">📷</div>
                        <div>
                    <div class="rc-prop">${app.esc(p?.name || 'Unknown')} · ${app.esc(b?.service_type || 'Service')}</div>
                    <div class="rc-meta">${app.esc(date)} · by ${app.esc(prov?.first_name || 'Provider')} ${app.esc(prov?.last_name || '')}</div>
                        </div>
                        ${badge}
                        <button class="rc-map-btn" onclick="app.reports.openMap(event, '${r.id}')">View Map</button>
                    </div>
                    <div class="rc-body">
                        <div>
                            <div class="rc-detail-label">Report ID</div>
                            <div class="rc-detail-val">#${r.id.split('-')[0]}</div>
                        </div>
                        <div>
                            <div class="rc-detail-label">Condition</div>
                            <div class="rc-detail-val">${app.esc(r.condition || '—')}</div>
                        </div>
                        <div>
                            <div class="rc-detail-label">Visit notes</div>
                            <div class="rc-detail-val">${app.esc(r.notes || r.work_summary || 'No summary')}</div>
                        </div>
                        ${(r.check_in_photo_url || r.before_photo_url || r.after_photo_url) ? `
                        <div style="grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;">
                            ${r.check_in_photo_url ? `<a href="${app.esc(r.check_in_photo_url)}" target="_blank" rel="noopener"><img src="${app.esc(r.check_in_photo_url)}" alt="Check-in photo" style="width:96px;height:72px;object-fit:cover;border-radius:8px;"></a>` : ''}
                            ${r.before_photo_url ? `<a href="${app.esc(r.before_photo_url)}" target="_blank" rel="noopener"><img src="${app.esc(r.before_photo_url)}" alt="Before photo" style="width:96px;height:72px;object-fit:cover;border-radius:8px;"></a>` : ''}
                            ${r.after_photo_url ? `<a href="${app.esc(r.after_photo_url)}" target="_blank" rel="noopener"><img src="${app.esc(r.after_photo_url)}" alt="After photo" style="width:96px;height:72px;object-fit:cover;border-radius:8px;"></a>` : ''}
                        </div>` : ''}
                    </div>
                </div>`;
            }).join('');
        },
        openMap(e, id) {
            e.stopPropagation();
            const r = app.reports.data.find(x => x.id === id);
            const p = app.reports.propsMap[r.property_id];
            if (!p || !p.lat) { alert('No GPS data available.'); return; }

            document.getElementById('mapModalTitle').textContent = `Check-in: ${p.name}`;
            document.getElementById('mapModal').classList.add('open');

            if (app.reports.map) { app.reports.map.remove(); app.reports.map = null; }
            setTimeout(() => {
                app.reports.map = L.map('reportMap').setView([p.lat, p.lng], 16);
                L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(app.reports.map);

                L.circle([p.lat, p.lng], { radius: p.geofence_radius, color: '#16a34a', fillColor: '#16a34a', fillOpacity: 0.15 }).addTo(app.reports.map);
                L.circleMarker([p.lat, p.lng], { radius: 6, color: '#fff', fillColor: '#2d5a3d', fillOpacity: 1, weight: 2 }).addTo(app.reports.map).bindPopup('Property Location');

                if (r.check_in_lat && r.check_in_lng) {
                    const color = r.inside_geofence ? '#16a34a' : '#dc2626';
                    L.circleMarker([r.check_in_lat, r.check_in_lng], { radius: 8, color: '#fff', fillColor: color, fillOpacity: 1, weight: 2 }).addTo(app.reports.map).bindPopup('Check-in Location').openPopup();
                    L.polyline([[p.lat, p.lng], [r.check_in_lat, r.check_in_lng]], { color: r.inside_geofence ? '#16a34a' : '#dc2626', dashArray: '5, 5', weight: 2 }).addTo(app.reports.map);
                }
            }, 100);
        },
        closeMap() {
            document.getElementById('mapModal').classList.remove('open');
            if (app.reports.map) { app.reports.map.remove(); app.reports.map = null; }
        }
    },

    alerts: {
        async load() {
            const { data } = await db.from('alerts').select('*').eq('owner_id', app.currentUser?.id).order('created_at', { ascending: false }).limit(30);
            app.alerts.data = data || [];

            const unread = app.alerts.data.filter(a => !a.is_read).length;
            const badge = document.getElementById('alertBadge');
            if (badge) { badge.style.display = unread > 0 ? 'inline' : 'none'; badge.textContent = unread; }

            const list = document.getElementById('alertsListFull');
            if (!list) return;
            if (app.alerts.data.length === 0) { list.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted);">No alerts to show.</div>`; return; }

            list.innerHTML = app.alerts.data.map(a => `
                <div class="alert-item ${a.is_read ? '' : 'unread'}" style="padding:16px;border-bottom:1px solid var(--border);border-left:4px solid ${a.is_read ? 'transparent' : 'var(--sage)'};">
                    <div style="font-weight:600;font-size:14px;color:var(--ink);">${app.esc(a.title || 'Alert')}</div>
                    <div style="margin-top:4px;font-size:13px;color:var(--muted);">${app.esc(a.message || '')}</div>
                    <div style="margin-top:8px;font-size:11px;color:var(--muted);">${new Date(a.created_at).toLocaleString()}</div>
                </div>
            `).join('');
        },
        async markAllRead() {
            if (!app.currentUser) return;
            await db.from('alerts').update({ is_read: true }).eq('owner_id', app.currentUser.id);
            await app.alerts.load();
        },
        subscribeRealTime() {
            if (!app.currentUser) return;
            db.channel('owner-alerts-' + app.currentUser.id)
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts', filter: `owner_id=eq.${app.currentUser.id}` }, () => app.alerts.load())
                .subscribe();
        }
    },

    openAddPropertyModal() {
        document.getElementById('addPropModal').classList.add('open');
        const typeSel = document.getElementById('propType');
        const typeOther = document.getElementById('propTypeOther');
        if (typeSel && typeOther) {
            typeSel.onchange = () => {
                typeOther.style.display = typeSel.value === 'Other' ? 'block' : 'none';
                if (typeSel.value === 'Other') typeOther.focus();
            };
            typeSel.onchange();
        }
        const search = document.getElementById('mapSearch');
        if (search) search.onblur = () => setTimeout(() => app.properties.hideSuggestions(), 150);
        setTimeout(() => {
            if (!app.properties.mapPicker) {
                app.properties.mapPicker = L.map('map-picker', {
                    zoomControl: true,
                    layers: [app.properties.layers.street]
                }).setView([10.8505, 76.2711], 7);

                app.properties.mapPicker.on('click', e => app.properties.placePin(e.latlng.lat, e.latlng.lng, true));
            } else { app.properties.mapPicker.invalidateSize(); }
        }, 100);
    },
    closeAddPropertyModal() {
        document.getElementById('addPropModal').classList.remove('open');
    },
    openBookingModal(propertyId) {
        setBookingDateTimeMinimum(document.getElementById('bookDate'), document.getElementById('bookTime'));
        app.bookings.loadPropertiesAndProvidersForModal().then(() => {
            if (propertyId) {
                const sel = document.getElementById('bookPropSelect');
                if (sel) sel.value = propertyId;
            }
        });
        document.getElementById('bookingModal').classList.add('open');
    },
    closeBookingModal() {
        document.getElementById('bookingModal').classList.remove('open');
    },
    openQAModal(e, bookingId, status) {
        if (e) e.stopPropagation();
        setBookingDateMinimum(document.getElementById('qaDueDate'));
        app.bookings.activeBookingId = bookingId;
        const triggerSel = document.getElementById('qaTriggerType');
        if (triggerSel) triggerSel.value = status === 'completed' ? 'complaint' : 'random';
        document.getElementById('qaModal').classList.add('open');
    },
    closeQAModal() {
        document.getElementById('qaModal').classList.remove('open');
        app.bookings.activeBookingId = null;
    },
    async submitQAAppoint() {
        const insId = document.getElementById('qaInspectorSelect').value;
        const tt = document.getElementById('qaTriggerType').value;
        const dd = document.getElementById('qaDueDate').value;
        if (!insId) { toast('Please select a QA inspector.', 'error'); return; }
        if (!dd) { toast('Please set a due date.', 'error'); return; }
        if (!isValidBookingDate(dd)) { toast('Please choose today or a future due date in Kerala time.', 'error'); return; }

        const btn = document.querySelector('#qaModal .btn-submit');
        if (btn) { btn.disabled = true; btn.textContent = 'Assigning…'; }

        const { error } = await db.from('qa_assignments').insert([{
            booking_id: app.bookings.activeBookingId,
            inspector_id: insId,
            owner_id: app.currentUser.id,
            trigger_type: tt,
            due_by: dd,
            status: 'assigned'
        }]);

        if (btn) { btn.disabled = false; btn.textContent = 'Appoint Inspector'; }

        if (error) { toast('Error: ' + error.message, 'error'); return; }
        app.closeQAModal();
        toast('QA Inspector assigned successfully ✓', 'success');
        if (window.location.hash === '#dashboard' || !window.location.hash) app.dashboard.loadRecentBookings();
        else if (window.location.hash === '#bookings') app.bookings.load();
    },
    async openMonitorModal(bookingId) {
        const modal = document.getElementById('monitorModal');
        const list = document.getElementById('monitorList');
        const mapEl = document.getElementById('monitorMap');
        modal.classList.add('open');
        list.innerHTML = `<div style="text-align:center;padding:20px;"><div class="spinner"></div></div>`;
        
        // Fetch Booking and Property Details for the map
        const { data: booking } = await db.from('bookings').select('*, properties(*)').eq('id', bookingId).single();
        
        // Correct join: provider_workers (Field Workers)
        const { data: workers } = await db.from('job_workers').select('*, provider_workers(*)').eq('booking_id', bookingId);
        
        if (!workers || workers.length === 0) {
            list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px;">No workers assigned to this job.</div>`;
            return;
        }

        const workerIds = workers.map(d => d.worker_id);
        const { data: checkins } = await db.from('worker_checkins').select('*').eq('booking_id', bookingId).in('worker_id', workerIds);
        const ciMap = {};
        (checkins || []).forEach(c => ciMap[c.worker_id] = c);

        list.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px;">` + workers.map(w => {
            const pw = w.provider_workers || {};
            const name = `${pw.first_name || ''} ${pw.last_name || ''}`.trim() || 'Field Worker';
            const ci = ciMap[w.worker_id];
            let statusHtml = `<div style="font-size:11px;color:var(--muted);padding:4px 8px;background:#f3f4f6;border-radius:12px;font-weight:500;">⏳ Not logged in</div>`;
            if (ci) {
                if (ci.inside_geofence) statusHtml = `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--success);padding:4px 8px;background:rgba(22,163,74,.1);border-radius:12px;font-weight:600;"><div class="pulse-dot green"></div>On Site</div>`;
                else statusHtml = `<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--error);padding:4px 8px;background:rgba(220,38,38,.1);border-radius:12px;font-weight:600;"><div class="pulse-dot red"></div>Outside</div>`;
            }
            return `
            <div style="background:#faf9f7;border:1px solid var(--border);border-radius:8px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="width:36px;height:36px;border-radius:50%;background:var(--sage-pale);display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--sage);">${app.esc(name[0])}</div>
                    <div><div style="font-size:13px;font-weight:500;color:var(--ink);">${app.esc(name)}</div><div style="font-size:10px;color:var(--muted);">ID: ${w.worker_id.substring(0, 6)}</div></div>
                </div>
                ${statusHtml}
            </div>`;
        }).join('') + `</div>`;

        // Map Initialization
        if (app.monitorModalMap) { app.monitorModalMap.remove(); app.monitorModalMap = null; }
        const prop = booking?.properties || {};
        if (prop.lat && prop.lng) {
            setTimeout(() => {
                app.monitorModalMap = L.map('monitorMap').setView([prop.lat, prop.lng], 16);
                L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(app.monitorModalMap);
                
                // Property Geofence
                L.circle([prop.lat, prop.lng], {
                    radius: prop.geofence_radius || 200,
                    color: '#2d5a3d', fillOpacity: 0.1, weight: 1
                }).addTo(app.monitorModalMap);
                
                // Worker Pins
                (checkins || []).forEach(ci => {
                    const pw = workers.find(w => w.worker_id === ci.worker_id)?.provider_workers || {};
                    const wn = (pw.first_name || 'Worker');
                    if (ci.check_in_lat && ci.check_in_lng) {
                        L.marker([ci.check_in_lat, ci.check_in_lng], {
                            icon: L.divIcon({
                                className: 'worker-marker',
                                html: `<div style="background:white;border:2px solid #2d5a3d;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;box-shadow:0 2px 5px rgba(0,0,0,0.2);">${app.esc(wn[0])}</div>`,
                                iconSize: [24, 24]
                            })
                        }).addTo(app.monitorModalMap).bindPopup(`<b>${app.esc(wn)}</b><br>Checked in: ${new Date(ci.check_in_time).toLocaleTimeString()}<br>${ci.inside_geofence ? '✅ Inside' : '🛑 Outside'}`);
                    }
                });
            }, 300);
        } else {
            mapEl.innerHTML = `<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;">Map coordinates missing for this property.</div>`;
        }
    },
    closeMonitorModal() {
        document.getElementById('monitorModal').classList.remove('open');
    },

    // ═══════════════ PAYMENT ═══════════════
    async getQuote(providerId, serviceType) {
        if (!providerId || !serviceType) return null;
        const { data, error } = await db.rpc('quote_booking', { p_provider: providerId, p_service: serviceType });
        if (error) { console.warn('Price quote failed:', error.message); return null; }
        return data;
    },
    async updatePricePreview() {
        const type = document.getElementById('bookService')?.value;
        const provId = document.getElementById('bookProvider')?.value;
        const el = document.getElementById('pricePreview');
        if (!el) return;
        const seq = (app._quoteSeq = (app._quoteSeq || 0) + 1);
        if (!provId || !type) {
            el.textContent = '💰 Choose a provider to see their services and prices.';
            return;
        }
        el.textContent = '💰 Getting price…';
        const q = await app.getQuote(provId, type);
        if (seq !== app._quoteSeq) return;
        if (!q) { el.textContent = '💰 Price unavailable right now.'; return; }
        const r = p => '₹' + Math.round(p / 100).toLocaleString('en-IN');
        el.textContent = `💰 Total ${r(q.total_paise)} — provider ${r(q.provider_paise)} + platform fee ${r(q.commission_paise)}. Held safely until the visit is completed.`;
    },
    openPaymentModal(serviceType, amountPaise, existingBookingId = null) {
        app.pendingPayAmount = amountPaise;
        app.pendingExistingBookingId = existingBookingId || null;
        const rupees = (amountPaise / 100).toLocaleString('en-IN');
        document.getElementById('payServiceLabel').textContent = serviceType;
        document.getElementById('payAmountLabel').textContent = `₹${rupees}`;
        document.getElementById('payConfirmBtn').textContent = `✅ Pay ₹${rupees}`;
        document.getElementById('paymentModal').style.display = 'flex';
    },
    payExistingBooking(bookingId) {
        const b = (app.bookings.data || []).find(x => x.id === bookingId);
        if (!b) return;
        const known = b._payment?.amount || b.amount;
        const open = amount => {
            if (!amount) { toast('No price is set for this service.', 'error'); return; }
            app.openPaymentModal(b.service_type, amount, bookingId);
        };
        if (known) { open(known); return; }
        app.getQuote(b.provider_id, b.service_type).then(q => open(q?.total_paise));
    },
    closePaymentModal() {
        document.getElementById('paymentModal').style.display = 'none';
        app.pendingBookingData = null;
        app.pendingExistingBookingId = null;
    },
    async confirmPayment() {
        const payingExisting = !!app.pendingExistingBookingId;
        if (!payingExisting && !app.pendingBookingData) return;
        const btn = document.getElementById('payConfirmBtn');
        const txnId = 'TT-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();

        if (payingExisting) {
            btn.disabled = true; btn.textContent = '⏳ Processing…';
            await new Promise(r => setTimeout(r, 800));
            const bookingId = app.pendingExistingBookingId;
            const booking = (app.bookings.data || []).find(x => x.id === bookingId);
            const { error: payErr } = await db.from('payments').upsert({
                booking_id: bookingId,
                owner_id: app.currentUser.id,
                provider_id: booking?.provider_id || null,
                amount: app.pendingPayAmount,
                status: 'paid',
                paid_at: new Date().toISOString(),
                transaction_id: txnId
            }, { onConflict: 'booking_id' });
            if (payErr) {
                toast('Payment failed: ' + payErr.message, 'error');
                btn.disabled = false; btn.textContent = `✅ Pay`;
                return;
            }
            if (!booking || booking.status === 'pending') {
                const { error: confirmErr } = await db.from('bookings').update({ status: 'confirmed' })
                    .eq('id', bookingId).eq('owner_id', app.currentUser.id);
                if (confirmErr) {
                    app.closePaymentModal();
                    btn.disabled = false;
                    toast('Payment recorded, but the booking could not be confirmed: ' + confirmErr.message, 'error');
                    app.bookings.load();
                    return;
                }
            }
            app.closePaymentModal();
            btn.disabled = false;
            toast('✅ Payment successful! Booking confirmed.', 'success');
            app.bookings.load();
            if (window.location.hash === '#dashboard' || !window.location.hash) app.dashboard.loadRecentBookings();
            return;
        }

        const { propId, type, date, time, provId, notes, amount } = app.pendingBookingData;

        if (!isValidBookingDateTime(date, time)) {
            toast('That booking slot is no longer available. Choose a future time between 8:00 AM and 5:30 PM IST.', 'error');
            app.closePaymentModal();
            return;
        }
        btn.disabled = true; btn.textContent = '⏳ Processing…';

        // Simulate 1.5s processing delay
        await new Promise(r => setTimeout(r, 1500));

        if (!isValidBookingDateTime(date, time)) {
            toast('That booking slot is no longer available. Choose a future time between 8:00 AM and 5:30 PM IST.', 'error');
            btn.disabled = false;
            app.closePaymentModal();
            return;
        }

        // Create booking
        const { data: newBooking, error: bErr } = await db.from('bookings').insert([{
            owner_id: app.currentUser.id,
            property_id: propId,
            provider_id: provId,
            service_type: type,
            scheduled_date: date,
            scheduled_time: time,
            notes: notes,
            status: 'confirmed', // direct to confirmed since paid
            amount: amount
        }]).select().single();

        if (bErr) {
            toast('Booking failed: ' + bErr.message, 'error');
            btn.disabled = false; btn.textContent = `✅ Pay`;
            return;
        }

        // Create payment record
        const { error: payInsErr } = await db.from('payments').insert([{
            booking_id: newBooking.id,
            owner_id: app.currentUser.id,
            provider_id: provId,
            amount: amount,
            status: 'paid',
            paid_at: new Date().toISOString(),
            transaction_id: txnId
        }]);

        app.closePaymentModal();
        app.closeBookingModal();
        btn.disabled = false;

        if (payInsErr) {
            toast('Booking created, but the payment record failed: ' + payInsErr.message + '. Use Pay on the Bookings page.', 'error');
        } else {
            toast(`✅ Payment successful! Booking confirmed.`, 'success');
        }

        // Refresh views
        app.bookings.load();
        if (window.location.hash === '#dashboard' || !window.location.hash) app.dashboard.loadRecentBookings();
    },

    // ═══════════════ AI CHATBOT & MATCHMAKER ═══════════════
    chatHistory: [],
    // gemini-1.5-flash was retired by Google; this alias tracks the current Flash model.
    GEMINI_MODEL: 'gemini-flash-latest',
    geminiKey: localStorage.getItem('tt_gemini_key') || '',

    toggleChatbot() {
        const w = document.getElementById('aiChatWindow');
        const t = document.getElementById('aiChatToggle');
        if (w.classList.contains('open')) {
            w.classList.remove('open');
            t.classList.add('pulse');
        } else {
            w.classList.add('open');
            t.classList.remove('pulse');
            if (!app.geminiKey) {
                app.openChatSettings();
            }
        }
    },

    openChatSettings() {
        document.getElementById('geminiKeyInput').value = app.geminiKey;
        document.getElementById('aiChatSettings').classList.add('open');
    },

    closeChatSettings() {
        document.getElementById('aiChatSettings').classList.remove('open');
    },

    saveGeminiKey() {
        const val = document.getElementById('geminiKeyInput').value.trim();
        if (val) {
            app.geminiKey = val;
            localStorage.setItem('tt_gemini_key', val);
            toast('Gemini AI Key saved successfully!', 'success');
            app.closeChatSettings();
        } else {
            toast('Please enter a valid key.', 'error');
        }
    },

    appendChatMsg(text, sender = 'user') {
        const body = document.getElementById('aiChatBody');
        const div = document.createElement('div');
        div.className = `chat-msg ${sender}`;
        const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        
        div.innerHTML = `
            <div class="chat-bubble"></div>
            <div class="chat-time"></div>
        `;
        div.querySelector('.chat-bubble').textContent = text;
        div.querySelector('.chat-time').textContent = time;
        body.appendChild(div);
        body.scrollTop = body.scrollHeight;
    },

    setTyping(isTyping) {
        const t = document.getElementById('aiChatTyping');
        const b = document.getElementById('aiChatBody');
        t.style.display = isTyping ? 'flex' : 'none';
        if (isTyping) { b.appendChild(t); b.scrollTop = b.scrollHeight; }
    },

    async sendChatMessage() {
        if (!app.geminiKey) {
            app.openChatSettings();
            return;
        }

        const inputEl = document.getElementById('aiChatInput');
        const text = inputEl.value.trim();
        if (!text) return;

        inputEl.value = '';
        document.getElementById('aiChatSend').disabled = true;

        app.appendChatMsg(text, 'user');
        app.chatHistory.push({ role: 'user', parts: [{ text: text }] });

        app.setTyping(true);

        // 1. Compile Live Context (RAG) securely
        let myPropsData = app.properties.data || [];
        if (!myPropsData.length && app.currentUser) {
            const { data } = await db.from('properties').select('id,name,city').eq('owner_id', app.currentUser.id).or('is_active.is.null,is_active.eq.true');
            myPropsData = data || [];
        }

        let provsData = app.allProviders || [];
        if (!provsData.length) {
            const { data } = await db.from('profiles').select('id,first_name,last_name,city,bio,experience_years').eq('role', 'provider');
            provsData = data || [];
            app.allProviders = provsData;
        }

        const myProps = myPropsData.map(p => `ID: ${p.id}, Name: ${p.name}, City: ${p.city}`).join(' | ');
        const provs = provsData.map(p => `ID: ${p.id}, Name: ${p.first_name || ''} ${p.last_name || ''}, Experience: ${p.experience_years || 0} yrs, City: ${p.city || 'Any'}`).join(' | ');
        
        const systemPrompt = `You are Tender AI, an assistant for a vacant-home care prototype. You may answer questions and suggest possible providers or services using the context below. You must never create bookings, charge or mark payments, change records, or claim an action has completed. For a booking request, provide a suggestion and clearly say the owner must review and submit it manually. Do not output machine-action commands.
CONTEXT DATA:
User Properties: ${myProps || 'None'}
Available Providers: ${provs || 'None'}
Today's Date: ${todayDateInputValue()}`;

        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${app.GEMINI_MODEL}:generateContent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': app.geminiKey },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents: app.chatHistory
                })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData?.error?.message || `HTTP ${response.status}`);
            }
            const data = await response.json();
            
            const aiRawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm sorry, I couldn't process that.";
            
            // 2. Parse for JSON Commands
            const jsonMatch = aiRawText.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch) {
                try {
                    const cmd = JSON.parse(jsonMatch[1]);
                    if (cmd.action === 'BOOK') {
                        const suggestion = `Booking suggestion only. Service: ${String(cmd.service_type || 'not specified')}; date: ${String(cmd.date || 'not specified')}. No booking or payment was made. Review the details and submit a booking manually.`;
                        app.appendChatMsg(suggestion, 'ai');
                        app.chatHistory.push({ role: 'model', parts: [{ text: suggestion }] });
                    }
                } catch(e) { console.error("JSON parse error from AI", e); }
            } else {
                app.appendChatMsg(aiRawText, 'ai');
                app.chatHistory.push({ role: 'model', parts: [{ text: aiRawText }] });
            }

        } catch (err) {
            console.error(err);
            app.appendChatMsg(`Error connecting to AI: ${err.message}. Please check your API key settings.`, 'ai');
        } finally {
            app.setTyping(false);
            document.getElementById('aiChatSend').disabled = false;
            inputEl.focus();
        }
    },

    async executeAiBooking() {
        throw new Error('AI can suggest bookings only. Review and submit bookings manually.');
    }
};
window.app = app;
app.init();

