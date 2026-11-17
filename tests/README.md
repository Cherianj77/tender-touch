# Tender Touch tests

These tests never touch the live Supabase project.

## 1. Database tests (`tests/db/`)
They run the real `database/supabase_setup.sql` and `database/audit_fixes_2026_11.sql` against a
**local** PostgreSQL 15+ database, with `tests/db/supabase_stub.sql` standing in for Supabase's
`auth`/`storage` schemas and `anon`/`authenticated` roles. Each scenario runs as the matching
API role with JWT claims, so Row Level Security, triggers and RPCs behave as they do in Supabase.

```sh
npm install pg @supabase/supabase-js jsdom      # once, in any folder on NODE_PATH
sh tests/db/mkdb.sh tt_fixed database/audit_fixes_2026_11.sql   # PGHOST=/tmp PGPORT=54322 by default
PGDATABASE=tt_fixed node --test tests/db/*.test.js
```
Covers: sign-up roles, privilege escalation, tenant isolation, booking time rules, payment-then-confirm,
provider GPS check-in (server geofence), job completion and payment release, provider→owner alerts,
worker secret links (get / check-in / check-out), QA appointment and verification, admin role changes,
QA account creation, account deletion, and portfolio storage permissions.

## 2. Frontend tests (`tests/frontend/`)
Each page's real HTML and scripts run in jsdom with the real supabase-js client; only the network is
faked, so the tests assert exactly which requests a user action sends.

```sh
node --test tests/frontend/*.test.js
```
