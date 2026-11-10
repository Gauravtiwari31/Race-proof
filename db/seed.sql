-- 10,000 users, 2,000 teams, one hackathon. hashtext() instead of random(), so every run produces
-- the same well-mixed data and the load test numbers are comparable. Sign in with any
-- user<n>@seed.local and the password demo-password-123. user1 leads a team; user9001 is unattached.

INSERT INTO hackathons (id, name, min_team_size, max_team_size)
VALUES ('11111111-1111-4111-8111-111111111111', 'Hack4Hack 2026', 2, 4);

CREATE TEMP TABLE seed_tags ON COMMIT DROP AS
SELECT ARRAY['react','typescript','node','postgres','python','go','rust','k8s','docker','aws','ml','pytorch',
             'figma','css','swift','kotlin','graphql','redis','terraform','llm','data','security','unity','solidity'] AS tags,
       ARRAY['frontend','backend','design','ml','devops','mobile'] AS roles,
       ARRAY['Asia/Kolkata','UTC','Europe/London','Europe/Berlin','America/New_York','America/Los_Angeles','Asia/Singapore','Asia/Tokyo'] AS zones,
       ARRAY['Aarav','Priya','Liam','Mei','Noah','Ananya','Sofia','Kenji','Zara','Omar','Isha','Lucas','Nia','Arjun','Elena','Tariq'] AS first_names,
       ARRAY['Sharma','Chen','Patel','Garcia','Khan','Nguyen','Smith','Iyer','Müller','Okafor','Tanaka','Rossi','Das','Silva','Reddy','Novak'] AS last_names;

CREATE TEMP TABLE seed_users ON COMMIT DROP AS
SELECT n, gen_random_uuid() AS id FROM generate_series(1, 10000) AS n;

INSERT INTO users (id, email, name, password_hash, skills, primary_role, timezone, avail_start_min, avail_end_min)
SELECT u.id,
       'user' || u.n || '@seed.local',
       first_names[1 + abs(hashtext('first' || u.n)) % 16] || ' ' || last_names[1 + abs(hashtext('last' || u.n)) % 16],
       -- argon2id of demo-password-123, the same for every seeded user so seeding stays instant
       '$argon2id$v=19$m=19456,t=2,p=1$AO1HfHYzr0FivrYjhS/vxg$0lPvvghhVsaQ+Cz12MN0scJKZTgKVZXKgaAt/ybqLdo',
       ARRAY(SELECT DISTINCT t FROM unnest(ARRAY[tags[1 + abs(hashtext('a' || u.n)) % 24], tags[1 + abs(hashtext('b' || u.n)) % 24], tags[1 + abs(hashtext('c' || u.n)) % 24]]) AS t),
       roles[1 + abs(hashtext('role' || u.n)) % 6],
       zones[1 + abs(hashtext('zone' || u.n)) % 8],
       480 + abs(hashtext('start' || u.n)) % 8 * 30,
       1020 + abs(hashtext('end' || u.n)) % 6 * 30
  FROM seed_users u, seed_tags;

-- Team sizes cycle through 2, 3, 4, 1, so a quarter of the teams are full and the board has churn.
CREATE TEMP TABLE seed_teams ON COMMIT DROP AS
SELECT i, gen_random_uuid() AS id, 1 + i % 4 AS size,
       coalesce(sum(1 + i % 4) OVER (ORDER BY i ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::int AS seat_offset
  FROM generate_series(1, 2000) AS i;

INSERT INTO teams (id, hackathon_id, name, looking_for, max_size, member_count, version, updated_at)
SELECT t.id, '11111111-1111-4111-8111-111111111111',
       (ARRAY['Null','Async','Atomic','Quantum','Rusty','Lambda','Kernel','Binary','Cosmic','Vector'])[1 + abs(hashtext('adj' || t.i)) % 10] || ' '
         || (ARRAY['Pointers','Otters','Commits','Foxes','Hackers','Ninjas','Wizards','Pandas','Rockets','Owls'])[1 + abs(hashtext('noun' || t.i)) % 10] || ' ' || t.i,
       ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[tags[1 + abs(hashtext('want1' || t.i)) % 24], tags[1 + abs(hashtext('want2' || t.i)) % 24]]) AS x),
       4, t.size, t.size,
       now() - t.i * interval '41 seconds'
  FROM seed_teams t, seed_tags;

CREATE TEMP TABLE seed_seats ON COMMIT DROP AS
SELECT t.id AS team_id, u.id AS user_id, s.ord, t.i
  FROM seed_teams t
 CROSS JOIN LATERAL generate_series(1, t.size) AS s(ord)
  JOIN seed_users u ON u.n = t.seat_offset + s.ord;

INSERT INTO memberships (hackathon_id, user_id, team_id, role, joined_at)
SELECT '11111111-1111-4111-8111-111111111111', user_id, team_id,
       CASE WHEN ord = 1 THEN 'leader' ELSE 'member' END,
       now() - interval '30 days' + i * interval '1 minute' + ord * interval '10 minutes'
  FROM seed_seats;

INSERT INTO participants (hackathon_id, user_id, looking, pitch, updated_at)
SELECT '11111111-1111-4111-8111-111111111111', u.id, s.user_id IS NULL,
       CASE WHEN s.user_id IS NULL THEN
         (ARRAY['Love shipping fast.','Happy to own the backend.','Looking for a design-minded team.','First hackathon, keen to learn.','Can pair across time zones.'])[1 + abs(hashtext('pitch' || u.n)) % 5]
       END,
       now() - u.n * interval '13 seconds'
  FROM seed_users u LEFT JOIN seed_seats s ON s.user_id = u.id;

-- The history a real team would have, so the time machine and the audit invariants work on seeded data.
INSERT INTO audit_events (hackathon_id, team_id, actor_id, action, team_version, payload, created_at)
SELECT '11111111-1111-4111-8111-111111111111', s.team_id, s.user_id,
       CASE WHEN s.ord = 1 THEN 'team.created' ELSE 'member.joined' END,
       s.ord,
       jsonb_build_object('userId', s.user_id, 'memberCount', s.ord),
       now() - interval '30 days' + s.i * interval '1 minute' + s.ord * interval '10 minutes'
  FROM seed_seats s
 ORDER BY s.i, s.ord;
