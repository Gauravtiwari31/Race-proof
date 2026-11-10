-- Every query must return zero rows. $1 scopes a check to one hackathon; NULL checks everything
-- except sandbox hackathons, whose "naive" arena mode corrupts its own throwaway team on purpose.

-- name: member_count_matches_memberships
SELECT t.id FROM teams t
  JOIN hackathons h ON h.id = t.hackathon_id
  LEFT JOIN memberships m ON m.team_id = t.id
 WHERE ($1::uuid IS NULL AND NOT h.is_sandbox) OR t.hackathon_id = $1
 GROUP BY t.id
HAVING count(m.user_id) <> t.member_count OR count(m.user_id) = 0;

-- name: exactly_one_leader
SELECT t.id FROM teams t
  JOIN hackathons h ON h.id = t.hackathon_id
  LEFT JOIN memberships m ON m.team_id = t.id AND m.role = 'leader'
 WHERE ($1::uuid IS NULL AND NOT h.is_sandbox) OR t.hackathon_id = $1
 GROUP BY t.id
HAVING count(m.user_id) <> 1;

-- name: within_capacity
SELECT t.id FROM teams t
  JOIN hackathons h ON h.id = t.hackathon_id
 WHERE t.member_count > t.max_size
   AND (($1::uuid IS NULL AND NOT h.is_sandbox) OR t.hackathon_id = $1);

-- name: no_visible_idempotency_placeholder
-- Keys are not per-hackathon, so this one is always global; $1 is only here to fit the runner.
SELECT user_id, key FROM idempotency_keys
 WHERE response_code = 0 AND ($1::uuid IS NULL OR true);

-- name: no_pending_request_from_member
SELECT r.id FROM join_requests r
  JOIN teams t ON t.id = r.team_id
  JOIN hackathons h ON h.id = t.hackathon_id
  JOIN memberships m ON m.hackathon_id = t.hackathon_id AND m.user_id = r.user_id
 WHERE r.status = 'pending'
   AND (($1::uuid IS NULL AND NOT h.is_sandbox) OR t.hackathon_id = $1);
