-- The Race Arena runs real transactions in a sandbox hackathon that the board and the
-- global invariant check both ignore, because its "naive" mode corrupts a team on purpose.
ALTER TABLE hackathons ADD COLUMN is_sandbox boolean NOT NULL DEFAULT false;

INSERT INTO hackathons (id, name, min_team_size, max_team_size, is_sandbox)
VALUES ('00000000-0000-4000-8000-00000000a7e0', 'Race Arena', 1, 4, true);

-- Keyset pagination sorts (updated_at DESC, id DESC); these must match to avoid a sort step.
DROP INDEX teams_open_seats;
CREATE INDEX teams_open_seats ON teams (hackathon_id, updated_at DESC, id DESC) WHERE member_count < max_size;

DROP INDEX participants_board;
CREATE INDEX participants_board ON participants (hackathon_id, updated_at DESC, user_id DESC) WHERE looking;
