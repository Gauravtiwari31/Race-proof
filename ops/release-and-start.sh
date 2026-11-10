#!/bin/sh
# Single-service start for hosts without a separate release step (Render's free plan): migrate and
# seed with the owner credential, then drop it from the environment before the API starts.
set -e
node dist/db/migrate.js
node dist/db/seed.js
exec env -u DATABASE_ADMIN_URL node dist/server.js
