// owner-bookings.js — Book a Visit page logic
let currentUser = null;
let bookings = [];
let activeBookingId = null; // for QA appointment

async function init() {
    currentUser = await initAuth();
    if (!currentUser) return;
    await Promise.all([loadProperties(), loadProviders(), loadBookings(), loadInspectors()]);

    // Pre-select property from URL param
    const params = new URLSearchParams(window.location.search);
    const propId = params.get('prop');
    if (propId) { document.getElementById('bookPropSelect').value = propId; openBookingModal(); }

    // Set default due date to tomorrow for QA modal
    document.getElementById('qaDueDate').value = dateInputValueInKerala(1);
}

async function loadProperties() {
    const { data } = await db.from('properties').select('id, name').eq('owner_id', currentUser.id).order('name');
    const sel = document.getElementById('bookPropSelect');
    sel.innerHTML = '<option value="">Select property…</option>';
    (data || []).forEach(p => {
        const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
    });
}

async function loadProviders() {
    const { data } = await db.from('profiles')
        .select('id, first_name, last_name, phone')
        .eq('role', 'provider')
        .order('first_name');
    const sel = document.getElementById('bookProvider');
    if (!data?.length) {
        sel.innerHTML = '<option value="">No providers registered yet</option>';
        return;
    }
    sel.innerHTML = '<option value="">Select a provider…</option>';
    data.forEach(p => {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = `${p.first_name || ''} ${p.last_name || ''}`.trim() + (p.phone ? ` · ${p.phone}` : '');
        sel.appendChild(o);
    });
}

async function loadBookings() {
    document.getElementById('bookingsTbody').innerHTML = `<tr><td colspan="6"><div class="loading-row"><div class="spinner"></div>Loading…</div></td></tr>`;
    const { data, error } = await db.from('bookings')
        .select('*, properties(name)')
        .eq('owner_id', currentUser.id)
        .order('scheduled_date', { ascending: false });
    bookings = error ? [] : (data || []);
    renderBookingsTable();
}

function renderBookingsTable() {
    const tbody = document.getElementById('bookingsTbody');
    if (!bookings || bookings.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted);font-size:13px;">
      No bookings yet. <a href="#" onclick="openBookingModal();return false" style="color:var(--sage);">Book your first visit →</a>
    </td></tr>`;
        return;
    }
    tbody.innerHTML = bookings.map(b => `<tr>
    <td><strong>${esc(b.properties?.name || '—')}</strong></td>
    <td>${esc(b.service_type)}</td>
    <td>${formatBookingDateTime(b.scheduled_date, b.scheduled_time)}</td>
    <td><span class="status-badge ${b.status}">${b.status.replace('_', ' ')}</span></td>
    <td>${b.provider_id
            ? `<span style="color:var(--success)">✅ Assigned</span>`
            : `<span style="color:var(--error)">⚠️ No provider</span> <button class="btn-ghost" style="font-size:10px;margin-left:4px;" onclick="reassignProvider('${b.id}')">Assign</button>`}
    </td>
    <td>
      ${qaLabel(b.status, b.id)}
    </td>
  </tr>`).join('');
}

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

// ── QA Inspectors ─────────────────────────────────────
let inspectors = [];
async function loadInspectors() {
    const { data } = await db.from('profiles').select('id, first_name, last_name').eq('role', 'qa_inspector');
    inspectors = data || [];
    const sel = document.getElementById('qaInspectorSelect');
    if (inspectors.length === 0) {
        sel.innerHTML = '<option value="">No inspectors available</option>';
        document.getElementById('qaNoInspectors').style.display = 'block';
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

// ── QA Appointment Modal ──────────────────────────────
function openQAModal(e, bookingId, status) {
    if (e) e.stopPropagation();
    setBookingDateMinimum(document.getElementById('qaDueDate'));
    activeBookingId = bookingId;
    // Update modal title and description based on audit type
    const titles = {
        completed: 'Verify Completed Work',
        in_progress: 'Request Surprise Spot Check',
        confirmed: 'Schedule Random Audit',
        pending: 'Request Pre-Visit Audit'
    };
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

    // Pre-select trigger type
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

    if (!inspectorId) { toast('Please select a QA inspector.', 'error'); return; }
    if (!dueDate) { toast('Please set a due date.', 'error'); return; }
    if (!isValidBookingDate(dueDate)) { toast('Please choose today or a future due date in Kerala time.', 'error'); return; }

    const btn = document.querySelector('#qaModal .btn-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Assigning…'; }

    const { error } = await db.from('qa_assignments').insert({
        booking_id: activeBookingId,
        inspector_id: inspectorId,
        owner_id: currentUser.id,
        trigger_type: triggerType,
        due_by: dueDate,
        status: 'assigned'
    });

    if (btn) { btn.disabled = false; btn.textContent = 'Appoint Inspector'; }
    if (error) { toast('Error: ' + error.message, 'error'); return; }

    toast('QA Inspector appointed! ✓', 'success');
    closeQAModal();
    await loadBookings();
}

// ── Booking Modal ─────────────────────────────────────
function openBookingModal() {
    setBookingDateTimeMinimum(document.getElementById('bookDate'), document.getElementById('bookTime'));
    document.getElementById('bookingModal').classList.add('open');
}
function closeBookingModal() { document.getElementById('bookingModal').classList.remove('open'); }

async function saveBooking() {
    const property_id = document.getElementById('bookPropSelect').value;
    const service_type = document.getElementById('bookService').value;
    const scheduled_date = document.getElementById('bookDate').value;
    const scheduled_time = document.getElementById('bookTime').value;
    const notes = document.getElementById('bookNotes').value.trim();

    if (!property_id || !scheduled_date || !scheduled_time) { toast('Please select a property, date, and time.', 'error'); return; }
    if (!isValidBookingDateTime(scheduled_date, scheduled_time)) { toast('Choose a future available slot between 8:00 AM and 5:30 PM IST, with 1 hour notice for today.', 'error'); return; }

    const provider_id = document.getElementById('bookProvider').value;
    if (!provider_id) { toast('Please select a service provider.', 'error'); return; }

    const { error } = await db.from('bookings').insert({
        property_id, owner_id: currentUser.id, service_type, scheduled_date, scheduled_time, notes, provider_id
    });
    if (error) { toast(error.message, 'error'); return; }

    toast('Booking requested! ✓', 'success');
    closeBookingModal();
    document.getElementById('bookNotes').value = '';
    await loadBookings();
}

init();
