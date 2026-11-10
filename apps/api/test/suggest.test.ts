import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  overlapHours,
  rank,
  scoreCandidate,
  utcOffsetMinutes,
  utcRanges,
  type Person,
} from '../src/modules/suggest/score.js';
import { admin, newHackathon, newTeam, newUser, startServer, statusAndCode, type Server } from './helpers.js';

const AT = new Date('2026-11-05T12:00:00Z');

const person = (over: Partial<Person> = {}): Person => ({
  id: 'p',
  skills: [],
  primaryRole: null,
  timezone: 'UTC',
  availStartMin: 540, // 09:00
  availEndMin: 1020, // 17:00
  ...over,
});

describe('suggestion scoring (pure)', () => {
  it('suggest.scoring: each part follows its documented weight and the total adds up', () => {
    const team = {
      lookingFor: ['postgres', 'k8s', 'react'],
      members: [person({ id: 'm', skills: ['react'], primaryRole: 'frontend' })],
    };
    const candidate = person({ id: 'c', skills: ['postgres', 'k8s', 'react', 'go'], primaryRole: 'backend' });
    const { score, explanation } = scoreCandidate(team, candidate, { at: AT, candidateUpdatedAt: AT });

    expect(explanation.covers).toEqual(['postgres', 'k8s']); // react is already on the team, so not "uncovered"
    expect(explanation.alreadyHave).toEqual(['react']);
    expect(explanation.tzOverlapHours).toBe(8);
    expect(explanation.fillsRole).toBe('backend');
    expect(explanation.parts).toEqual({ coverage: 0.5, redundancy: -0.037, tz: 0.3, role: 0.15, recency: 0.05 });
    expect(score).toBe(0.963);
  });

  it('suggest.no-coverage: someone who covers nothing and duplicates everything scores low', () => {
    const team = { lookingFor: ['rust'], members: [person({ skills: ['go'], primaryRole: 'backend' })] };
    const { score, explanation } = scoreCandidate(
      team,
      person({ skills: ['go'], primaryRole: 'backend', availStartMin: 0, availEndMin: 60 }),
      { at: AT, candidateUpdatedAt: null },
    );
    expect(explanation.parts).toEqual({ coverage: 0, redundancy: -0.15, tz: 0, role: 0, recency: 0 });
    expect(score).toBe(-0.15);
  });

  it('suggest.tz-wraparound: a window past local midnight overlaps correctly in UTC', () => {
    const nightOwl = person({ availStartMin: 1320, availEndMin: 120 }); // 22:00 to 02:00
    const lateShift = person({ availStartMin: 60, availEndMin: 180 }); // 01:00 to 03:00
    expect(overlapHours(nightOwl, lateShift, AT)).toBe(1);
    expect(utcRanges(1320, 120, 0)).toEqual([[1320, 1440], [0, 120]]);
  });

  it('suggest.tz-offsets: India and UTC windows are compared in the same clock', () => {
    const india = person({ timezone: 'Asia/Kolkata', availStartMin: 540, availEndMin: 1020 }); // 03:30 to 11:30 UTC
    const london = person({ timezone: 'UTC', availStartMin: 540, availEndMin: 1020 }); // 09:00 to 17:00 UTC
    expect(utcOffsetMinutes('Asia/Kolkata', AT)).toBe(330);
    expect(overlapHours(india, london, AT)).toBe(2.5);
  });

  it('suggest.tz-dst: the offset follows the date, not a fixed table', () => {
    expect(utcOffsetMinutes('America/New_York', new Date('2026-07-01T12:00:00Z'))).toBe(-240);
    expect(utcOffsetMinutes('America/New_York', new Date('2026-12-01T12:00:00Z'))).toBe(-300);
  });

  it('suggest.empty-window: a zero-length window overlaps nothing', () => {
    expect(overlapHours(person({ availStartMin: 600, availEndMin: 600 }), person(), AT)).toBe(0);
  });

  it('suggest.recency: only the last 24 hours count', () => {
    const team = { lookingFor: [], members: [person()] };
    const at = (iso: string) => scoreCandidate(team, person(), { at: AT, candidateUpdatedAt: new Date(iso) }).explanation.parts.recency;
    expect(at('2026-11-05T00:00:00Z')).toBe(0.05);
    expect(at('2026-11-03T00:00:00Z')).toBe(0);
  });

  it('suggest.tie-break: equal scores order by id, so results are stable', () => {
    const items = [{ id: 'b', score: 0.5 }, { id: 'a', score: 0.5 }, { id: 'c', score: 0.9 }];
    expect(rank(items, 2).map((i) => i.id)).toEqual(['c', 'a']);
  });
});

describe('suggestion API', () => {
  let api: Server;

  beforeAll(async () => {
    api = await startServer();
  });
  afterAll(() => api.stop());

  it('suggest.for-team: ranks people who cover what the team seeks, and explains why', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    await admin.query(`UPDATE teams SET looking_for = '{postgres,k8s}' WHERE id = $1`, [team.id]);
    const [strong, weak, irrelevant] = [await newUser(), await newUser(), await newUser()];
    await admin.query(`UPDATE users SET skills = '{postgres,k8s}' WHERE id = $1`, [strong.id]);
    await admin.query(`UPDATE users SET skills = '{postgres}' WHERE id = $1`, [weak.id]);
    await admin.query(`UPDATE users SET skills = '{cobol}' WHERE id = $1`, [irrelevant.id]);
    for (const u of [strong, weak, irrelevant]) await api.put(`/hackathons/${hackathonId}/participation`, u, { looking: true });

    const res = await api.get(`/hackathons/${hackathonId}/suggestions?for=team`, team.leader);
    expect(res.status).toBe(200);
    expect(res.body.suggestions.map((s: { userId: string }) => s.userId)).toEqual([strong.id, weak.id]);
    expect(res.body.suggestions[0].explanation.covers).toEqual(['postgres', 'k8s']);
    expect(res.body.suggestions[0].explanation.parts.coverage).toBe(0.5);
  });

  it('suggest.for-user: ranks open teams for someone looking', async () => {
    const hackathonId = await newHackathon({ max: 2 });
    const [good, full] = [await newTeam(hackathonId, 1), await newTeam(hackathonId, 2)];
    await admin.query(`UPDATE teams SET looking_for = '{rust}' WHERE id = ANY($1::uuid[])`, [[good.id, full.id]]);
    const user = await newUser();
    await admin.query(`UPDATE users SET skills = '{rust}' WHERE id = $1`, [user.id]);
    const res = await api.get(`/hackathons/${hackathonId}/suggestions?for=user`, user);
    expect(res.body.suggestions.map((s: { teamId: string }) => s.teamId)).toEqual([good.id]);
  });

  it('suggest.not-in-team: team suggestions need a team', async () => {
    const res = await api.get(`/hackathons/${await newHackathon()}/suggestions?for=team`, await newUser());
    expect(statusAndCode(res)).toBe('409 NOT_A_MEMBER');
  });
});
