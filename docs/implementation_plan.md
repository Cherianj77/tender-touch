# Tender Touch — Full Platform Implementation Plan

Build a fully working multi-role property care platform using vanilla HTML/JS + Supabase.

## User Review Required

> [!IMPORTANT]
> **Free API key needed:** Weather feature uses [OpenWeatherMap](https://openweathermap.org/api) (free tier). You need to create a free account and paste in your API key. I'll add a placeholder in the code.

> [!IMPORTANT]
> **Supabase tables must be created** before dashboards show real data. SQL scripts are provided — you'll run them in the Supabase SQL editor. I'll write them for you.

---

## Proposed Changes

### 1 — Supabase Database Setup

#### [NEW] `supabase_setup.sql` — run in Supabase SQL Editor
Creates all tables, RLS policies, and triggers:

| Table | Purpose |
|---|---|
| `profiles` | One row per user; stores role, name, phone |
| `properties` | Properties owned by an owner |
| `bookings` | Service visits booked on a property |
| `visit_reports` | Photo + notes per completed visit |
| `alerts` | Weather/emergency alerts per property |
| `inspections` | QA inspector reports |

- Row-Level Security: owners see only their own data; providers see jobs assigned to them; admin sees all.
- Auto-create `profiles` row on signup via Supabase trigger.

---

### 2 — Shared Files

#### [NEW] `js/supabase-client.js`
Single place that initialises the Supabase client — all pages import this.

#### [NEW] `js/auth-guard.js`
Checks session on page load; redirects to [login.html](file:///c:/Users/aaron/OneDrive/Desktop/tendertouch/login.html) if not logged in. All dashboard pages load this.

---

### 3 — Owner Dashboard (`owner-dashboard.html`)

Sections:
- **Sidebar** — logo, nav links (Overview, Properties, Bookings, Alerts, Settings), user avatar + name, logout
- **Stats row** — total properties · upcoming bookings · active alerts
- **My Properties** — cards with address, last-visit date, weather badge; **Add Property** button → modal
- **Add Property Modal** — name, address, map pin picker (Leaflet.js), geo-fence radius slider
- **Upcoming Bookings** — table showing date, service type, assigned provider, status
- **Weather Widget** — OpenWeatherMap API for each property's city (temperature, condition, monsoon warning if heavy rain)
- **Recent Alerts** panel

Live features:
- `supabaseClient.from('properties').select()` — load real properties
- `supabaseClient.from('bookings').select()` — load bookings
- Add property form → `supabaseClient.from('properties').insert()`
- Real-time alert badge using Supabase Realtime subscription

---

### 4 — Provider Dashboard (`provider-dashboard.html`)

Sections:
- **Sidebar** — same style, different nav (My Jobs, History, Earnings)
- **Assigned Jobs** — cards with property address, date, task list
- **Check-in Button** — uses `navigator.geolocation` to get current GPS coords; compares to property geo-fence (lat/lng + radius); shows ✅ if inside, ❌ if outside (geo-fencing feature)
- **Upload Photos** — before/after photos per visit → stored in Supabase Storage
- **Earnings** — sum of completed visits

---

### 5 — QA Inspector Dashboard (`qa-inspector-dashboard.html`)

Sections:
- **Inspections Queue** — list of completed visits awaiting QA
- **Submit Inspection Report** — checklist form (cleanliness, damage, security) + photo upload + notes → stored in `inspections` table
- **Inspection History** — past reports with status

---

### 6 — Admin Dashboard (`admin-dashboard.html`)

Sections:
- **Users table** — all owners + providers; can change role
- **All Bookings** — full list with filter by status; can assign provider
- **Properties Map** — Leaflet.js map showing all properties as pins
- **Alerts Manager** — create/dismiss alerts for any property

---

### 7 — Property Detail Page (`property-detail.html`)

- Full property info + map view with geo-fence circle (Leaflet.js)
- Weather card (OpenWeatherMap live data)
- Booking history for that property
- Visit reports + photo gallery

---

## Third-Party Libraries (all CDN, no install needed)

| Library | Use |
|---|---|
| [Leaflet.js](https://leafletjs.com/) | Interactive maps + geo-fence circles |
| [OpenWeatherMap API](https://openweathermap.org/) | Live weather per property city |
| [Supabase JS v2](https://supabase.com/docs/reference/javascript) | Auth + database + storage |

---

## Build Order

```
Step 1 → supabase_setup.sql  (you run in Supabase)
Step 2 → js/supabase-client.js + js/auth-guard.js
Step 3 → owner-dashboard.html  (full working page)
Step 4 → provider-dashboard.html  (geo-fencing check-in)
Step 5 → qa-inspector-dashboard.html
Step 6 → admin-dashboard.html
Step 7 → property-detail.html
```

---

## Verification Plan

### After Step 1 (SQL)
- Open Supabase → Table Editor → confirm all tables exist

### After Step 3 (Owner Dashboard)
- Sign up a new account → login → should land on `owner-dashboard.html`
- Click "Add Property" → fill form → submit → property card should appear
- Weather badge should show real temperature for property city

### After Step 4 (Provider Dashboard)
- Login as provider role
- Click "Check In" on a job → browser asks for location permission
- If near property address → shows ✅ Inside geo-fence
- If far away → shows ❌ Outside geo-fence

### After Step 5 (QA)
- Login as `qa_inspector` → submit inspection form → appears in history
