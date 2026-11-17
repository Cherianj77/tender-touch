// owner-alerts.js — Alerts page logic
let currentUser = null;
let alerts = [];

async function init() {
    currentUser = await initAuth();
    if (!currentUser) return;
    await loadAlerts();
    subscribeRealTime();
}

async function loadAlerts() {
    document.getElementById('alertsList').innerHTML = `<div class="loading-row"><div class="spinner"></div>Loading alerts…</div>`;
    const { data, error } = await db.from('alerts')
        .select('*')
        .eq('owner_id', currentUser.id)
        .order('created_at', { ascending: false })
        .limit(30);
    alerts = error ? [] : (data || []);
    renderAlerts();
    // Update sidebar badge
    const unread = alerts.filter(a => !a.is_read).length;
    const badge = document.getElementById('alertBadge');
    if (badge) { badge.style.display = unread > 0 ? 'inline' : 'none'; badge.textContent = unread; }
}

function renderAlerts() {
    const list = document.getElementById('alertsList');
    if (!alerts || alerts.length === 0) {
        list.innerHTML = `<div class="empty-state">
      <div class="empty-icon"><svg fill="none" stroke="currentColor" stroke-width="1.2" viewBox="0 0 24 24"><path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159a2.032 2.032 0 01-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg></div>
      <div class="empty-title">No alerts</div>
      <div class="empty-desc">You're all clear. Alerts appear here automatically — weather warnings, QA results, and more.</div>
    </div>`;
        return;
    }

    list.innerHTML = alerts.map(a => `
    <div class="alert-item ${a.is_read ? '' : 'unread'} ${a.type || 'info'}">
      <div class="alert-dot ${a.type || 'info'}">
        <svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
          ${a.type === 'danger' ? '<path d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>'
            : a.type === 'weather' ? '<path d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4 4 0 003 15z"/>'
                : a.type === 'warning' ? '<path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>'
                    : '<path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>'}
        </svg>
      </div>
      <div style="flex:1">
        <div class="alert-title">${esc(a.title)}</div>
        ${a.message ? `<div class="alert-msg">${esc(a.message)}</div>` : ''}
      </div>
      <div class="alert-time">${timeAgo(a.created_at)}</div>
    </div>`).join('');
}

async function markAllRead() {
    await db.from('alerts').update({ is_read: true }).eq('owner_id', currentUser.id);
    await loadAlerts();
    toast('All alerts marked as read.', 'success');
}

function subscribeRealTime() {
    db.channel('owner-alerts-' + currentUser.id)
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'alerts', filter: `owner_id=eq.${currentUser.id}` },
            async () => { await loadAlerts(); })
        .subscribe();
}

init();
