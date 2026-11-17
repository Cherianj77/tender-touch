// ── admin-dashboard.js ────────────────────────────────────────────
let currentUser = null;

let allUsers = [];
let allBookings = [];
let allProperties = [];
let allQA = [];
let allAlerts = [];

function toast(msg, type = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = `toast show ${type}`;
    setTimeout(() => t.classList.remove('show'), 3000);
}

function esc(str) { const node = document.createElement('span'); node.textContent = str || ''; return node.innerHTML; }
async function logout() { await db.auth.signOut(); window.location.href = 'login.html'; }

async function init() {
    currentUser = await initAuth();
    if (!currentUser) return;

    const { data: adminCheck, error: roleErr } = await db.rpc('is_admin');
    let isAdmin = adminCheck;
    if (roleErr || adminCheck === null) {
        const { data: prof } = await db.from('profiles').select('role').eq('id', currentUser.id).single();
        isAdmin = (prof && prof.role === 'admin');
    }

    if (!isAdmin) {
        document.querySelector('.main').innerHTML = `<div style="text-align:center;padding:100px;"><h2>Admin Access Required</h2><p style="margin-top:12px;color:var(--muted)">You don't have permission to access this page.</p><a href="login.html" style="display:inline-block;margin-top:20px;color:var(--sage);">Return to Login</a></div>`;
        return;
    }

    await refreshAll();
}

async function refreshAll() {
    const [u, b, p, q, a, py] = await Promise.all([
        db.from('profiles').select('*').order('created_at', { ascending: false }),
        // provider_id / inspector_id / owner_id reference auth.users, not profiles, so
        // PostgREST cannot embed profiles through them; names are joined below instead.
        db.from('bookings').select('*, properties(name,city)').order('created_at', { ascending: false }),
        db.from('properties').select('*').order('created_at', { ascending: false }),
        db.from('qa_assignments').select('*, bookings(service_type, properties(name))').order('assigned_at', { ascending: false }),
        db.from('alerts').select('*').order('created_at', { ascending: false }).limit(100),
        db.from('payments').select('*')
    ]);
    const failed = [['users', u], ['bookings', b], ['properties', p], ['QA', q], ['alerts', a], ['payments', py]]
        .filter(([, r]) => r.error);
    if (failed.length) {
        console.error('Admin data load errors:', failed.map(([n, r]) => `${n}: ${r.error.message}`));
        toast('Some admin data could not be loaded: ' + failed.map(([n]) => n).join(', '), 'error');
    }
    allUsers = u.data || [];
    const profileById = Object.fromEntries(allUsers.map(x => [x.id, x]));
    allBookings = (b.data || []).map(x => ({ ...x, profiles: profileById[x.provider_id] || null }));
    allProperties = p.data || [];
    allQA = (q.data || []).map(x => ({ ...x, profiles: profileById[x.inspector_id] || null }));
    allAlerts = (a.data || []).map(x => ({ ...x, profiles: profileById[x.owner_id] || null }));
    const allPayments = py.data || [];

    // Index payments by booking_id
    const payMap = {};
    allPayments.forEach(pm => { payMap[pm.booking_id] = pm; });
    allBookings = allBookings.map(b => ({ ...b, _payment: payMap[b.id] || null }));

    const owners = allUsers.filter(u => u.role === 'owner').length;
    const providers = allUsers.filter(u => u.role === 'provider').length;
    const activeQA = allQA.filter(q => q.status !== 'completed').length;
    const heldInEscrow = allPayments.filter(pm => pm.status === 'paid').reduce((sum, pm) => sum + (pm.amount || 0), 0);
    const commissionEarned = allPayments.filter(pm => pm.status === 'released').reduce((sum, pm) => sum + (pm.commission_amount || 0), 0);

    document.getElementById('adminStats').innerHTML = `
        <div class="stat-card"><div class="stat-value">${allUsers.length}</div><div class="stat-label">Total Users</div></div>
        <div class="stat-card"><div class="stat-value">${allProperties.length}</div><div class="stat-label">Properties</div></div>
        <div class="stat-card"><div class="stat-value">${allBookings.length}</div><div class="stat-label">Total Bookings</div></div>
        <div class="stat-card"><div class="stat-value">${activeQA}</div><div class="stat-label">Active QA</div></div>
        <div class="stat-card"><div class="stat-value" style="font-size:20px;">₹${(heldInEscrow / 100).toLocaleString('en-IN')}</div><div class="stat-label">Held until completion</div></div>
        <div class="stat-card"><div class="stat-value" style="font-size:20px;">₹${(commissionEarned / 100).toLocaleString('en-IN')}</div><div class="stat-label">Commission earned</div></div>
    `;

    if (document.getElementById('userCount')) document.getElementById('userCount').textContent = `${allUsers.length} users (${owners} owners, ${providers} providers)`;
    if (document.getElementById('bookCount')) document.getElementById('bookCount').textContent = `${allBookings.length} total`;
    if (document.getElementById('propCount')) document.getElementById('propCount').textContent = `${allProperties.length} total`;

    renderOverview(); renderUsers(); renderBookings(); renderProperties(); renderQA(); renderAlerts();
}

function renderOverview() {
    const recentBookings = allBookings.slice(0, 8);
    const recentUsers = allUsers.slice(0, 8);
    const activeQA = allQA.filter(q => q.status !== 'completed').slice(0, 10);

    const bEl = document.getElementById('overviewBookings');
    if (bEl) bEl.innerHTML = recentBookings.length === 0
        ? `<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--muted);">No bookings yet</td></tr>`
        : recentBookings.map(b => `<tr>
            <td><strong>${esc(b.properties?.name || '—')}</strong><br><span style="font-size:11px;color:var(--muted);">${esc(b.properties?.city || '')}</span></td>
            <td>${esc(b.service_type)}</td>
            <td><span class="status-badge ${b.status}">${(b.status || '').replace('_', ' ')}</span></td>
        </tr>`).join('');

    const uEl = document.getElementById('overviewUsers');
    if (uEl) uEl.innerHTML = recentUsers.length === 0
        ? `<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--muted);">No users yet</td></tr>`
        : recentUsers.map(u => `<tr>
            <td><strong>${esc(u.first_name)} ${esc(u.last_name)}</strong></td>
            <td><span class="role-badge role-${esc(u.role)}">${esc((u.role || '').replace('_', ' '))}</span></td>
            <td style="color:var(--muted);font-size:12px;">${formatDate(u.created_at)}</td>
        </tr>`).join('');

    const qEl = document.getElementById('overviewQA');
    if (qEl) qEl.innerHTML = activeQA.length === 0
        ? `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted);">No active QA assignments</td></tr>`
        : activeQA.map(q => `<tr>
            <td><strong>${esc(q.bookings?.properties?.name || '—')}</strong></td>
            <td>${esc(q.profiles?.first_name || '')} ${esc(q.profiles?.last_name || '')}</td>
            <td><span style="background:var(--sage-pale);padding:3px 8px;border-radius:10px;font-size:11px;color:var(--sage);">${esc(q.trigger_type)}</span></td>
            <td style="font-size:12px;color:var(--muted);">${q.due_by ? formatDate(q.due_by) : '—'}</td>
            <td><span class="status-badge ${q.status}">${q.status}</span></td>
        </tr>`).join('');
}

function renderUsers() {
    const tbody = document.getElementById('usersTbody');
    if (!tbody) return;
    tbody.innerHTML = allUsers.length === 0
        ? `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted);">No users found</td></tr>`
        : allUsers.map(u => `<tr>
            <td><strong>${esc(u.first_name)} ${esc(u.last_name || '')}</strong></td>
            <td style="font-family:monospace;font-size:12px;color:var(--muted);">${esc(u.id.slice(0, 8))}…</td>
            <td><span class="role-badge role-${esc(u.role)}">${esc((u.role || '—').replace('_', ' '))}</span></td>
            <td style="color:var(--muted);font-size:12px;">${formatDate(u.created_at)}</td>
            <td>
                <select onchange="changeRole('${u.id}', this.value, this)" style="padding:5px 8px;border:1px solid var(--border);border-radius:8px;font-size:12px;font-family:'DM Sans',sans-serif;cursor:pointer;">
                    <option value="">Change role…</option>
                    <option value="owner"${u.role === 'owner' || u.id === currentUser.id ? ' disabled' : ''}>Owner</option>
                    <option value="provider"${u.role === 'provider' || u.id === currentUser.id ? ' disabled' : ''}>Provider</option>
                    <option value="qa_inspector"${u.role === 'qa_inspector' || u.id === currentUser.id ? ' disabled' : ''}>QA Inspector</option>
                    <option value="admin"${u.role === 'admin' || u.id === currentUser.id ? ' disabled' : ''}>Admin</option>
                </select>
            </td>
            <td>
                <button onclick="deleteUserAccount('${esc(u.id)}')" style="background:var(--error);color:white;border:none;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:600;cursor:pointer;opacity:0.9;">Delete</button>
            </td>
        </tr>`).join('');
}

async function deleteUserAccount(userId) {
    const target = allUsers.find(x => x.id === userId);
    const userName = `${target?.first_name || ''} ${target?.last_name || ''}`.trim() || 'this user';
    const confirmed = await confirmDialog(`This permanently deletes the account for "${userName}" and all of its properties, bookings and history. It cannot be undone.`, { okLabel: 'Delete account', danger: true, requireText: 'DELETE' });
    if (!confirmed) {
        toast('Deletion cancelled.', 'info');
        return;
    }

    try {
        // Step 1: Clean up Storage API
        // Try to clear the provider's folder in provider-portfolios
        const { data: files } = await db.storage.from('provider-portfolios').list(userId);
        if (files && files.length > 0) {
            const filePaths = files.map(f => `${userId}/${f.name}`);
            await db.storage.from('provider-portfolios').remove(filePaths);
        }

        // Step 2: Delete from the Database
        const { error } = await db.rpc('delete_user_account', { target_user_id: userId });
        if (error) throw error;

        toast('User account deleted.', 'success');
        await refreshAll();
    } catch (err) {
        console.error("Deletion failed:", err);
        toast(`Failed to delete user: ${err.message}`, 'error');
    }
}

async function changeRole(userId, newRole, selectEl) {
    if (!newRole) return;
    const confirmed = await confirmDialog(`Change this user's role to "${newRole.replace('_', ' ')}"?`, { okLabel: 'Change role' });
    if (!confirmed) { selectEl.value = ''; return; }

    // Try RPC first for safe admin privilege escalation, with fallback to direct update
    let { error } = await db.rpc('admin_set_user_role', { target_user_id: userId, new_role: newRole });
    if (error) {
        ({ error } = await db.from('profiles').update({ role: newRole }).eq('id', userId));
    }
    if (error) {
        toast('Error: ' + error.message, 'error');
        selectEl.value = '';
    } else {
        toast(`Role changed to ${newRole.replace('_', ' ')} ✓`, 'success');
        await refreshAll();
    }
}

function renderBookings() {
    const tbody = document.getElementById('bookingsTbody');
    if (!tbody) return;
    tbody.innerHTML = allBookings.length === 0
        ? `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted);">No bookings found</td></tr>`
        : allBookings.map(b => {
            const prov = b.profiles;
            const provName = prov ? `${prov.first_name || ''} ${prov.last_name || ''}`.trim() || '—' : '—';
            const pm = b._payment;
            let payBadge = '—';
            if (pm) {
                if (pm.status === 'paid') payBadge = `<span style="font-size:11px;padding:3px 8px;border-radius:10px;background:rgba(22,163,74,.08);color:var(--success);">✅ Paid ₹${(pm.amount / 100).toLocaleString('en-IN')}</span>`;
                else if (pm.status === 'released') payBadge = `<span style="font-size:11px;padding:3px 8px;border-radius:10px;background:rgba(45,90,61,.1);color:var(--sage);">💰 Released ₹${(pm.amount / 100).toLocaleString('en-IN')}</span>`;
                else if (pm.status === 'refunded') payBadge = `<span style="font-size:11px;padding:3px 8px;border-radius:10px;background:rgba(107,114,128,.08);color:var(--muted);">↩ Refunded</span>`;
                else payBadge = `<span style="font-size:11px;padding:3px 8px;border-radius:10px;background:rgba(220,38,38,.08);color:var(--error);">⏳ Unpaid ₹${(pm.amount / 100).toLocaleString('en-IN')}</span>`;
            }
            return `<tr>
                <td><strong>${esc(b.properties?.name || '—')}</strong><br><span style="font-size:11px;color:var(--muted);">${esc(b.properties?.city || '')}</span></td>
                <td>${esc(b.service_type)}</td>
                <td style="font-size:12px;color:var(--muted);">${formatBookingDateTime(b.scheduled_date, b.scheduled_time)}</td>
                <td>${esc(provName)}</td>
                <td>${payBadge}</td>
                <td><span class="status-badge ${b.status}">${(b.status || '').replace('_', ' ')}</span></td>
            </tr>`;
        }).join('');
}

function renderProperties() {
    const tbody = document.getElementById('propsTbody');
    if (!tbody) return;
    tbody.innerHTML = allProperties.length === 0
        ? `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted);">No properties found</td></tr>`
        : allProperties.map(p => `<tr>
            <td><strong>${esc(p.name)}</strong></td>
            <td>${esc(p.city)}, ${esc(p.state || 'Kerala')}</td>
            <td>${esc(p.property_type || '—')}</td>
            <td>${p.geofence_radius ? p.geofence_radius + 'm' : '—'}</td>
            <td>${p.lat ? '<span style="color:var(--success)">✅ Set</span>' : '<span style="color:var(--error)">❌ Missing</span>'}</td>
        </tr>`).join('');
}

function renderQA() {
    const tbody = document.getElementById('qaTbody');
    if (!tbody) return;
    tbody.innerHTML = allQA.length === 0
        ? `<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted);">No QA assignments found</td></tr>`
        : allQA.map(q => {
            const insp = q.profiles;
            const inspName = insp ? `${insp.first_name || ''} ${insp.last_name || ''}`.trim() : 'Unknown';
            return `<tr>
                <td><strong>${esc(q.bookings?.properties?.name || '—')}</strong></td>
                <td>${esc(inspName)}</td>
                <td><span style="background:var(--sage-pale);padding:3px 8px;border-radius:10px;font-size:11px;color:var(--sage);">${esc(q.trigger_type)}</span></td>
                <td style="font-size:12px;color:var(--muted);">${q.due_by ? formatDate(q.due_by) : '—'}</td>
                <td><span class="status-badge ${q.status}">${q.status}</span></td>
            </tr>`;
        }).join('');
}

function renderAlerts() {
    const tbody = document.getElementById('alertsTbody');
    if (!tbody) return;
    tbody.innerHTML = allAlerts.length === 0
        ? `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--muted);">No alerts</td></tr>`
        : allAlerts.map(a => {
            const owner = a.profiles;
            const ownerName = owner ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() : '—';
            return `<tr>
                <td style="color:var(--muted);font-size:12px;">${formatDate(a.created_at)}</td>
                <td><span class="role-badge" style="background:rgba(220,38,38,.1);color:#dc2626;">${esc(a.type || 'info')}</span></td>
                <td style="font-weight:500;">${esc(a.title)}</td>
                <td style="font-size:12px;color:var(--muted);">${esc(ownerName)}</td>
            </tr>`;
        }).join('');
}

function switchTab(name) {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('nav-' + name).classList.add('active');
    document.getElementById('panel-' + name).classList.add('active');
    // Refresh overview to sync with latest data
    if (name === 'overview') renderOverview();
}

// ── Role promotion via Users table (replaces broken create_qa_user RPC) ──
// To add a QA inspector: ask them to sign up normally, then use the
// role dropdown in the Users tab to promote them to 'qa_inspector'.

init();
