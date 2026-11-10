CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  password_hash text NOT NULL,                  -- argon2id
  skills text[] NOT NULL DEFAULT '{}',          -- normalised lowercase tags
  primary_role text,                            -- frontend, backend, design, ml...
  timezone text NOT NULL,                       -- IANA, validated against the Intl list
  avail_start_min int NOT NULL CHECK (avail_start_min BETWEEN 0 AND 1439),
  avail_end_min int NOT NULL CHECK (avail_end_min BETWEEN 0 AND 1439)
);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,                 -- sha256(token); the token itself is never stored
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE hackathons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  min_team_size int NOT NULL CHECK (min_team_size >= 1),
  max_team_size int NOT NULL CHECK (max_team_size >= min_team_size)
);

CREATE TABLE participants (                     -- the "looking for teammates" board
  hackathon_id uuid NOT NULL REFERENCES hackathons,
  user_id uuid NOT NULL REFERENCES users,
  looking boolean NOT NULL DEFAULT true,
  pitch text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hackathon_id, user_id)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id uuid NOT NULL REFERENCES hackathons,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  looking_for text[] NOT NULL DEFAULT '{}',
  max_size int NOT NULL,                        -- copied from the hackathon at creation
  member_count int NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0,            -- bumps on every seat or leadership change
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (member_count BETWEEN 0 AND max_size),  -- belt and braces
  UNIQUE (id, hackathon_id)                     -- target of the composite FK below
);
CREATE UNIQUE INDEX teams_name_uq ON teams (hackathon_id, lower(name));

CREATE TABLE memberships (
  hackathon_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users,
  team_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('leader', 'member')),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (hackathon_id, user_id),          -- ONE TEAM PER PERSON, enforced by the DB
  -- The PK only protects one-team-per-person if hackathon_id is truthful, so tie it to the team.
  FOREIGN KEY (team_id, hackathon_id) REFERENCES teams (id, hackathon_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_leader_per_team ON memberships (team_id) WHERE role = 'leader';
CREATE INDEX memberships_team_seniority ON memberships (team_id, joined_at, user_id);

CREATE TABLE invite_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams ON DELETE CASCADE,
  code_hash bytea UNIQUE NOT NULL,              -- sha256(code); plaintext never stored
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  max_uses int CHECK (max_uses >= 1),
  uses int NOT NULL DEFAULT 0,
  created_by uuid NOT NULL
);
CREATE INDEX invite_codes_team ON invite_codes (team_id);

CREATE TABLE join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users,
  message text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_pending_request ON join_requests (team_id, user_id) WHERE status = 'pending';
CREATE INDEX join_requests_team ON join_requests (team_id);
CREATE INDEX join_requests_user_pending ON join_requests (user_id) WHERE status = 'pending';

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL,
  key uuid NOT NULL,
  endpoint text NOT NULL,
  request_hash bytea NOT NULL,
  response_code int NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

CREATE TABLE audit_events (                     -- audit log AND transactional outbox
  id bigserial PRIMARY KEY,
  hackathon_id uuid NOT NULL,
  team_id uuid,                                 -- no FK: history outlives deleted teams
  actor_id uuid NOT NULL,
  action text NOT NULL,
  team_version bigint,
  payload jsonb NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_team ON audit_events (team_id, id);
CREATE INDEX audit_events_hackathon ON audit_events (hackathon_id, id);

CREATE TABLE rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  hits int NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);

-- Board read paths.
CREATE INDEX participants_board ON participants (hackathon_id, updated_at DESC, user_id) WHERE looking;
CREATE INDEX users_skills ON users USING gin (skills);
CREATE INDEX teams_looking_for ON teams USING gin (looking_for);
CREATE INDEX teams_open_seats ON teams (hackathon_id, updated_at DESC, id) WHERE member_count < max_size;
