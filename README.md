# Tender Touch

**Care visits for vacant homes in Kerala, coordinated online.**

Tender Touch connects property owners who live away from their homes (often overseas) with local
service providers who visit, clean, inspect and look after the property. Every visit is verified
with GPS check-ins, time on site and photos, and the owner's payment is held by the platform until
the work is done.

> **Status:** working prototype. Payments are simulated (no real money moves), and the AI assistant
> is optional. See [Limitations](#limitations).

---

## Who uses it

| Role | What they can do |
|---|---|
| **Property owner** | Add properties with a map pin and geo-fence, photos, book visits from a provider's price list, pay (held until completion), cancel with refund, track workers live, read visit reports, appoint QA inspectors, remove a property while keeping its history |
| **Service provider** | List services and prices (custom "Other" services too), see assigned jobs, GPS check-in with a stamped photo, manage a team of field workers, submit work reports with before/after photos, get paid on verified completion |
| **Field worker** | No account needed: opens a private check-in link from their provider, checks in and out with GPS on the day of the job |
| **QA inspector** | Receives inspection assignments, verifies location on site, submits a pass/fail checklist and verdict |
| **Administrator** | Sees all users, bookings, properties, QA work and alerts; changes roles, creates QA accounts, deletes accounts; sees money held and commission earned |

## Key features

- **Verified visits.** A job can only be marked completed if the provider checked in **inside the
  property's geo-fence** (or one of their workers did), stayed **at least 15 minutes**, checked out,
  and uploaded an **after photo**. Check-in times are recorded by the server and can't be edited.
  Check-in opens only on the day of the visit.
- **Money held until the work is done.** The owner pays when booking; the payment is held by
  Tender Touch and released to the provider automatically on verified completion. Cancelling refunds
  the owner. Nobody can release, change or delete a payment by hand.
- **Provider price lists + platform commission.** Providers set their own price per service and
  see exactly what owners pay. Tender Touch adds a **10% commission** (one setting in the database).
  Owners can only book services a provider actually lists.
- **Maps and search.** OpenStreetMap maps with a geo-fence circle, place search that suggests
  places as you type (Kerala first), mini-map previews on property cards.
- **Live worksite view.** Owners see which workers are on site, outside the fence, or have left.
- **Security by design.** All access rules live in PostgreSQL Row Level Security and triggers, so
  they hold even if someone bypasses the web pages: owners see only their data, providers only
  their assigned jobs, workers only their own link.

## Tech stack

- **Frontend:** plain HTML, CSS and JavaScript (no build step)
- **Backend:** [Supabase](https://supabase.com): authentication, PostgreSQL with Row Level
  Security, storage for photos, database functions and triggers for business rules
- **Maps:** [Leaflet](https://leafletjs.com) with OpenStreetMap tiles; place search via
  [Photon](https://photon.komoot.io); weather via [Open-Meteo](https://open-meteo.com)
- **Optional AI assistant:** Google Gemini (suggestions only; it never books or pays)

## Run it locally

You need Python (for a simple local web server) and a browser.

```powershell
cd tender-touch
py -m http.server 8000     # or: python3 -m http.server 8000
```

Open <http://localhost:8000>. `index.html` is the home page; sign in from there.

The app connects to the Supabase project configured in `js/supabase-config.js` (URL and public
anon key: safe for browser code; never put a `service_role` key there).

## Set up your own Supabase project

1. Create a Supabase project and put its URL and anon key in `js/supabase-config.js`.
2. In **SQL Editor**, run `database/supabase_setup.sql`, then these in order (each is safe to re-run):
   1. `database/audit_fixes_2026_11.sql`
   2. `database/property_photos.sql`
   3. `database/property_archive.sql`
   4. `database/provider_logic_fixes.sql`
   5. `database/visit_evidence.sql`
   6. `database/provider_pricing.sql`
   7. `database/provider_services_custom.sql`
3. In **Authentication → URL Configuration**, add `http://localhost:8000/reset-password.html`
   as a redirect URL (for password reset emails).
4. Create your first administrator by setting `role = 'admin'` on your profile in the SQL Editor;
   admins can then promote other users from the Admin dashboard.

More detail: [`docs/START_HERE.md`](docs/START_HERE.md).

## Project structure

```
index.html                 Home page
login.html, signup.html,   Sign-in, sign-up, password reset
reset-password.html
owner-app.html             Owner dashboard (properties, bookings, reports, alerts)
provider-dashboard.html    Provider dashboard (jobs, workers, services & prices)
worker-checkin.html        Field worker check-in page (private link, no login)
qa-dashboard.html          QA inspector dashboard
admin-dashboard.html       Administrator dashboard
owner-*.html               Older multi-page owner screens (still working)
js/                        Page scripts; shared-auth.js has shared helpers
css/dashboard.css          Shared styles
database/                  Supabase schema, security rules and migrations
tests/                     Automated tests (database + frontend)
docs/                      Setup notes
```

## Tests

The tests never touch a live project.

- **Database tests** (`tests/db/`) run the real schema and migrations on a local PostgreSQL,
  acting as each user role, to check permissions, booking rules, payments, visit evidence and
  anti-cheating rules.
- **Frontend tests** (`tests/frontend/`) run each page's real scripts with the real Supabase
  client in a simulated browser, with the network faked.

See [`tests/README.md`](tests/README.md) for how to run them.

## Limitations

- Payments are a **demo checkout**; connect a real payment provider before handling money.
- GPS can be faked with special phone apps; the geo-fence, time-on-site and photo checks make
  cheating harder but not impossible.
- The Gemini key for the AI assistant is stored in the browser; a public deployment should call
  Gemini from a server.
- There is no rating system yet (the provider rating shown is a placeholder).
