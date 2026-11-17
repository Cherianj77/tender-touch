# Tender Touch: Start Here

## What the app is

Tender Touch is a browser-based prototype for coordinating care visits at vacant properties. Its pages are intended for property owners, service providers, field workers, QA inspectors, and administrators.

A typical flow is:

1. An owner signs in, adds a property, and requests a service visit.
2. A provider reviews assigned jobs and records a visit.
3. A worker can use a check-in link to report their location and visit time.
4. An owner or QA inspector reviews visit reports and alerts.

The browser UI is HTML/CSS/JavaScript. Supabase is the intended authentication and hosted PostgreSQL service. Leaflet displays maps; Open-Meteo supplies weather; the optional Tender AI feature calls Gemini.

## Important: current state

This copy is a prototype, not a verified production deployment. The Supabase project was paused, then restored; its dashboard currently reports Healthy. The URL and public anon key in `js/supabase-config.js` point to that project. Some features still depend on database tables, storage buckets, and policies being available.

There is no Node.js server or `package.json` in this folder. Do not describe this copy as having a Node.js backend. Its pages call Supabase from browser JavaScript.

## Run the pages locally

Open PowerShell in this folder and run:

```powershell
py -m http.server 8000
```

Then open `http://localhost:8000`. Keep the PowerShell window open. `index.html` is the landing page; sign-in and sign-up are linked from there.

## Supabase project status

The Tender Touch Supabase project was paused and has now been restored. Its dashboard reports the project as healthy. `js/supabase-config.js` contains a URL and public anon/publishable key that match that project.

The database already contains application tables and real records. In particular, `job_workers` has existing assignments, so never run the setup script blindly against this database. The script now preserves that table and no longer writes example profile/property values, but it still changes database policies and schema. Review changes and take a backup before applying SQL.

The database already includes `worker_checkins` with existing check-in records. The setup script now preserves existing worker assignments and check-ins. The earlier broad public policies on those tables have been removed. `database/secure_worker_checkins.sql` adds secret-link RPCs without deleting existing rows. Earlier verification confirmed 4 existing assignments, 4 matching tokens, and all 4 existing check-ins remained.

The latest review also prepared `database/security_hardening.sql`. It tightens role changes, booking updates, QA assignment access, provider/worker records, and GPS check-in validation. It was applied to the live Supabase project and seven read-only checks passed. In addition, `database/system_improvements.sql` was prepared to add worker specialization support, automatic payment release upon job completion, and a safe admin role management RPC. Frontend compatibility fixes were also applied to `owner-app.js` (removed nonexistent property notes column), `provider-dashboard.js` (specialization & resilient payment updates), and `admin-dashboard.js` (RPC role changer).

If Supabase again reports “Failed to fetch,” first check whether the project is active. A paused project cannot serve sign-in or database requests.

## Main files

- `index.html`: public landing page.
- `login.html`, `signup.html`: authentication screens.
- `owner-app.html` and `js/owner-app.js`: owner application and dashboard behavior.
- `provider-dashboard.html` and `js/provider-dashboard.js`: provider jobs and visit reporting.
- `worker-checkin.html`: worker GPS check-in flow.
- `qa-dashboard.html`, `admin-dashboard.html`: QA and admin screens.
- `js/shared-auth.js`: shared session/profile logic for dashboard pages.
- `js/supabase-config.js`: the single Supabase browser configuration.
- `database/supabase_setup.sql`: database tables and access policies.
- `archive/duplicates/`: saved alternate copies; these are not loaded by the app.

## Learning path

1. **HTML:** page structure, forms, buttons, and links.
2. **CSS:** layout, colors, spacing, and responsive styles.
3. **JavaScript:** event listeners, form validation, `async`/`await`, and updating the page.
4. **Database:** tables such as `profiles`, `properties`, `bookings`, and `visit_reports`.
5. **Supabase:** sign-in, database queries like `db.from('properties').select(...)`, and Row Level Security.
6. **GPS/maps:** browser location, latitude/longitude, map markers, and checking distance from a property.

Learn one page and one user flow at a time. The Tender Touch Supabase project is connected, but some flows still require dashboard settings such as the password-reset redirect URL.

## Accuracy and safety notes

- Booking forms require a date and time. Visits can be scheduled in half-hour slots from 8:00 AM to 5:30 PM IST, with at least one hour's notice for same-day visits. The `database/booking_date_guard.sql` database migration was applied earlier; it enforces these rules for direct API requests too. Existing bookings keep a blank time because their original appointment time is unknown.
- The checkout interface is explicitly a demo and records simulated payment states; it is not connected to a real payment provider.
- Password recovery now sends a Supabase reset email and handles the recovery link on `reset-password.html`. In Supabase Dashboard, open Authentication → URL Configuration and add the exact local redirect URL `http://localhost:8000/reset-password.html` to Redirect URLs. If you serve the app on another port, add that URL too. A working email provider is required to receive the message.
- Workers use a private check-in link for each assigned job; `worker-checkin.html` is not a normal login destination. Admin and QA accounts must be assigned by an administrator.
- Tender AI is configured to provide suggestions only; it must not book or mark payments as paid automatically.
- Gemini keys are not included in source code. A browser-stored key can still be exposed to anyone using that browser, so a public deployment should call Gemini through a protected server and use restricted keys.
- The Supabase URL and public key are centralized in `js/supabase-config.js` and match the Tender Touch project.
- For an interview, describe the project as a prototype and be precise about which work you personally did. Do not claim you implemented features you did not build.

## Database setup notes

The setup script preserves the `job_workers` and `worker_checkins` tables if it is run again. Still, review the current schema and back up project data before running other SQL against an existing project. The secure worker check-in migration is in `database/secure_worker_checkins.sql` and has been applied to the current Supabase project. It creates per-assignment secret tokens and server-side RPCs. It preserves existing assignments and check-ins.

## November 2026 audit

An audit fixed frontend bugs (provider report submission crashed after marking the job complete,
worker reassignment invalidated every check-in link, owner payment for a pending booking never
confirmed it, QA "Start Inspection" broke on names with an apostrophe, admin tables loaded empty,
several stored-XSS paths) and prepared `database/audit_fixes_2026_11.sql`.

**Apply `database/audit_fixes_2026_11.sql` in the Supabase SQL Editor after taking a backup.** It is
additive and safe to run more than once. Until it is applied: providers' alerts to owners are rejected,
paying for a pending booking cannot confirm it, admin user deletion fails, sign-up phone numbers are
not saved, and any signed-in user can delete any provider's portfolio images.

Automated tests are in `tests/` (see `tests/README.md`).

## Database changes applied on 17 Nov 2026 (in this order)

All of these are already applied to the live Tender Touch Supabase project. To rebuild a
database, run `database/supabase_setup.sql` and then these files in order. Each is safe to run twice.

1. `audit_fixes_2026_11.sql`: sign-up phone, paid-booking confirmation, provider alerts, admin delete, portfolio storage rules
   (`rollback_before_audit_fixes_2026_11.sql` restores what this replaced)
2. `property_photos.sql`: property photos and their storage folder
3. `property_archive.sql`: removed (archived) properties keep their history and can't be booked
4. `provider_logic_fixes.sql`: no check-in before the visit day; accurate "jobs completed"
5. `visit_evidence.sql`: a job can only be completed with on-site evidence (geo-fence, 15 minutes, check-out, after photo)
6. `provider_pricing.sql`: provider price lists, 10% platform commission, money held until verified completion
7. `provider_services_custom.sql`: custom ("Other") services; owners can only book services a provider lists

The commission rate is the `commission_percent` row in `platform_settings`.
