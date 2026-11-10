-- The API connects with a login role that is a member of fndn_app (see apps/api/src/db/migrate.ts).
-- Append-only audit is therefore a database guarantee, not a code convention.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fndn_app') THEN
    CREATE ROLE fndn_app NOLOGIN;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, participants, teams, memberships, invite_codes,
  join_requests, idempotency_keys, rate_limits
TO fndn_app;
GRANT SELECT ON hackathons TO fndn_app;
GRANT SELECT, INSERT ON audit_events TO fndn_app;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO fndn_app;
