// Shared Supabase client used by all dashboard pages.
const db = window.createTenderTouchClient();

/**
 * Call at the top of every page's init().
 * Checks auth → redirects to login if no session.
 * Populates sidebar user info and date.
 * Returns the current user object, or null.
 */
async function initAuth() {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { window.location.href = 'login.html'; return null; }

    const user = session.user;
    const meta = user.user_metadata || {};
    const firstName = meta.first_name || user.email.split('@')[0];
    const lastName = meta.last_name || '';
    const fullName = (firstName + ' ' + lastName).trim() || user.email;

    // Browser metadata is untrusted. It can request only the public signup roles;
    // the database profile remains the source of truth for authorization.
    const requestedRole = meta.role === 'provider' ? 'provider' : 'owner';
    const { error: profileInsertError } = await db.from('profiles').upsert({
        id: user.id,
        first_name: firstName,
        last_name: lastName,
        phone: meta.phone || null,
        role: requestedRole
    }, { onConflict: 'id', ignoreDuplicates: true });
    if (profileInsertError) console.error('Could not ensure the profile exists:', profileInsertError);

    const { data: profile, error: profileError } = await db.from('profiles')
        .select('role').eq('id', user.id).maybeSingle();
    if (profileError || !profile?.role) {
        console.error('Could not verify the signed-in account role:', profileError);
        const message = document.createElement('p');
        message.textContent = 'We could not verify your account role. Please sign out and contact the project administrator.';
        message.setAttribute('role', 'alert');
        message.style.cssText = 'margin:24px;padding:16px;border-radius:8px;background:#fff3cd;color:#664d03;';
        document.body.prepend(message);
        return null;
    }

    const routes = {
        owner: 'owner-app.html',
        provider: 'provider-dashboard.html',
        qa_inspector: 'qa-dashboard.html',
        admin: 'admin-dashboard.html'
    };
    const pageRoles = {
        'owner-app.html': 'owner',
        'owner-dashboard.html': 'owner',
        'owner-properties.html': 'owner',
        'owner-bookings.html': 'owner',
        'owner-reports.html': 'owner',
        'owner-alerts.html': 'owner',
        'provider-dashboard.html': 'provider',
        'qa-dashboard.html': 'qa_inspector',
        'admin-dashboard.html': 'admin'
    };
    const page = window.location.pathname.split('/').pop().toLowerCase();
    const expectedRole = pageRoles[page];
    if (expectedRole && profile.role !== expectedRole) {
        window.location.replace(routes[profile.role] || 'login.html');
        return null;
    }

    // Sidebar
    const avatarEl = document.getElementById('sidebarAvatar');
    const nameEl = document.getElementById('sidebarName');
    if (avatarEl) avatarEl.textContent = firstName[0].toUpperCase();
    if (nameEl) nameEl.textContent = fullName;

    // Date
    const dateEl = document.getElementById('currentDate');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-IN', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
    });

    // Alert badge
    loadAlertBadge(user.id);

    return user;
}




async function loadAlertBadge(userId) {
    const { data } = await db.from('alerts').select('id').eq('owner_id', userId).eq('is_read', false);
    const count = data ? data.length : 0;
    const badge = document.getElementById('alertBadge');
    if (badge) {
        badge.style.display = count > 0 ? 'inline' : 'none';
        badge.textContent = count;
    }
}

async function logout() {
    await db.auth.signOut();
    window.location.href = 'login.html';
}

// ── Shared helpers (available on every page) ──────────────────────
// In-page confirmation dialog. Native confirm()/prompt() are blocked in some
// embedded browsers (they silently return false/null), so destructive actions
// use this instead. Resolves true only when the user confirms.
function confirmDialog(message, { okLabel = 'Confirm', danger = false, requireText = '' } = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(26,26,24,.55);display:flex;align-items:center;justify-content:center;z-index:10002;padding:20px;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:14px;max-width:420px;width:100%;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-family:inherit;';
        const text = document.createElement('p');
        text.style.cssText = 'margin:0 0 18px;font-size:14px;line-height:1.6;color:#252522;white-space:pre-line;';
        text.textContent = message;
        box.appendChild(text);
        let input = null;
        if (requireText) {
            input = document.createElement('input');
            input.placeholder = `Type ${requireText} to confirm`;
            input.style.cssText = 'width:100%;padding:10px 12px;border:1px solid #d6d3cc;border-radius:8px;font-size:14px;margin-bottom:16px;box-sizing:border-box;';
            box.appendChild(input);
        }
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.textContent = 'Cancel';
        cancel.style.cssText = 'padding:9px 18px;border-radius:8px;border:1px solid #d6d3cc;background:#fff;cursor:pointer;font-size:13px;';
        const ok = document.createElement('button');
        ok.type = 'button'; ok.textContent = okLabel;
        ok.style.cssText = `padding:9px 18px;border-radius:8px;border:none;color:#fff;cursor:pointer;font-size:13px;background:${danger ? '#dc2626' : '#2d5a3d'};`;
        row.append(cancel, ok);
        box.appendChild(row);
        overlay.appendChild(box);
        const done = result => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
        const onKey = e => { if (e.key === 'Escape') done(false); };
        const syncOk = () => { if (input) { ok.disabled = input.value.trim() !== requireText; ok.style.opacity = ok.disabled ? '.5' : '1'; } };
        if (input) { input.addEventListener('input', syncOk); syncOk(); }
        cancel.onclick = () => done(false);
        ok.onclick = () => { if (!ok.disabled) done(true); };
        overlay.onclick = e => { if (e.target === overlay) done(false); };
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        (input || ok).focus();
    });
}
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function formatDate(d) {
    if (!d) return '—';
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(d));
    const date = dateOnly ? new Date(`${d}T00:00:00Z`) : new Date(d);
    const options = { day: 'numeric', month: 'short', year: 'numeric' };
    if (dateOnly) options.timeZone = 'UTC';
    return date.toLocaleDateString('en-IN', options);
}

// Booking dates use Kerala's calendar day even when an owner is overseas.
function dateInputValueInKerala(offsetDays = 0) {
    const target = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(target);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function todayDateInputValue() {
    return dateInputValueInKerala();
}

function isValidBookingDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    const isCalendarDate = parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day;
    return isCalendarDate && value >= todayDateInputValue();
}

const BOOKING_OPEN_TIME = '08:00';
const BOOKING_LAST_START_TIME = '17:30';
const BOOKING_NOTICE_MINUTES = 60;

function keralaClockParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function earliestBookingTimeToday() {
    const future = new Date(Date.now() + BOOKING_NOTICE_MINUTES * 60_000);
    const { hour, minute } = keralaClockParts(future);
    const total = Math.ceil((Number(hour) * 60 + Number(minute)) / 30) * 30;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function isValidBookingDateTime(dateValue, timeValue) {
    if (!isValidBookingDate(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue || '')) return false;
    if (!['00', '30'].includes(timeValue.slice(-2))) return false;
    if (timeValue < BOOKING_OPEN_TIME || timeValue > BOOKING_LAST_START_TIME) return false;
    if (dateValue > todayDateInputValue()) return true;
    return timeValue >= earliestBookingTimeToday();
}

function setBookingDateTimeMinimum(dateInput, timeInput) {
    if (!dateInput || !timeInput) return;
    const earliest = earliestBookingTimeToday();
    dateInput.min = earliest <= BOOKING_LAST_START_TIME ? todayDateInputValue() : dateInputValueInKerala(1);
    if (dateInput.dataset.timeBoundsBound !== 'true') {
        dateInput.addEventListener('change', () => updateBookingTimeBounds(dateInput, timeInput));
        dateInput.dataset.timeBoundsBound = 'true';
    }
    updateBookingTimeBounds(dateInput, timeInput);
}

function updateBookingTimeBounds(dateInput, timeInput) {
    timeInput.min = dateInput.value === todayDateInputValue() ? earliestBookingTimeToday() : BOOKING_OPEN_TIME;
    if (timeInput.min < BOOKING_OPEN_TIME) timeInput.min = BOOKING_OPEN_TIME;
    timeInput.max = BOOKING_LAST_START_TIME;
}

// QA due dates are date-only; still reject calendar days before today in Kerala.
function setBookingDateMinimum(dateInput) {
    if (!dateInput) return;
    dateInput.min = todayDateInputValue();
}

function formatBookingDateTime(dateValue, timeValue) {
    const date = formatDate(dateValue);
    if (!timeValue) return date;
    const [hour, minute] = timeValue.split(':').map(Number);
    const displayTime = new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString('en-IN', {
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC'
    });
    return `${date} · ${displayTime} IST`;
}

function timeAgo(iso) {
    const secs = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return Math.floor(secs / 86400) + 'd ago';
}

function toast(msg, type = 'success') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = `toast show ${type}`;
    setTimeout(() => t.classList.remove('show'), 3500);
}

function wmoDesc(c) {
    const m = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 61: 'Slight rain', 63: 'Rain', 65: 'Heavy rain', 80: 'Rain showers', 81: 'Heavy showers', 95: 'Thunderstorm' };
    return m[c] || 'Mixed conditions';
}
function wmoIcon(c) {
    if (c === 0) return '☀️'; if (c <= 3) return '🌤️'; if (c <= 48) return '🌫️';
    if (c <= 67) return '🌧️'; if (c <= 82) return '🌦️'; return '⛈️';
}

// Haversine distance formula — returns distance in METRES between two GPS points
function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Stub used by owner-bookings to re-assign a provider to an existing booking
async function reassignProvider(bookingId) {
    const newId = prompt('Paste provider user ID to reassign:');
    if (!newId) return;
    const { error } = await db.from('bookings').update({ provider_id: newId }).eq('id', bookingId);
    if (error) { alert('Error: ' + error.message); } else { alert('Provider updated! Reload the page.'); }
}

