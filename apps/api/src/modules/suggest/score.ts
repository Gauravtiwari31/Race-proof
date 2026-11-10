/** Pure scoring: no I/O and no clock of its own, so every number here can be unit tested. */

export interface Person {
  id: string;
  skills: string[];
  primaryRole: string | null;
  timezone: string;
  availStartMin: number;
  availEndMin: number;
}

export interface TeamProfile {
  lookingFor: string[];
  members: Person[];
}

export interface Explanation {
  covers: string[];
  alreadyHave: string[];
  tzOverlapHours: number;
  fillsRole: string | null;
  parts: { coverage: number; redundancy: number; tz: number; role: number; recency: number };
}

export const WEIGHTS = { coverage: 0.5, redundancy: -0.15, tz: 0.3, role: 0.15, recency: 0.05 };

const DAY = 1440;
const FULL_TZ_SCORE_HOURS = 8;
const RECENT_MS = 24 * 60 * 60 * 1000;

const round = (n: number, places = 3) => {
  const factor = 10 ** places;
  const rounded = Math.round(n * factor) / factor;
  return rounded === 0 ? 0 : rounded; // no -0 in API responses
};

/** Offset of a zone at an instant, in minutes east of UTC. Depends on `at` because of DST. */
export function utcOffsetMinutes(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/** A local window as UTC minute ranges, split wherever it crosses midnight UTC. */
export function utcRanges(start: number, end: number, offset: number): Array<[number, number]> {
  const length = (end - start + DAY) % DAY; // end before start means the window wraps past local midnight
  if (length === 0) return [];
  const from = (((start - offset) % DAY) + DAY) % DAY;
  const to = from + length;
  return to <= DAY ? [[from, to]] : [[from, DAY], [0, to - DAY]];
}

export function overlapHours(a: Person, b: Person, at: Date): number {
  const rangesA = utcRanges(a.availStartMin, a.availEndMin, utcOffsetMinutes(a.timezone, at));
  const rangesB = utcRanges(b.availStartMin, b.availEndMin, utcOffsetMinutes(b.timezone, at));
  let minutes = 0;
  for (const [s1, e1] of rangesA) {
    for (const [s2, e2] of rangesB) minutes += Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
  }
  return minutes / 60;
}

export function scoreCandidate(
  team: TeamProfile,
  candidate: Person,
  context: { at: Date; candidateUpdatedAt: Date | null },
): { score: number; explanation: Explanation } {
  const teamSkills = new Set(team.members.flatMap((m) => m.skills));
  const uncovered = team.lookingFor.filter((skill) => !teamSkills.has(skill));
  const candidateSkills = new Set(candidate.skills);

  const covers = uncovered.filter((skill) => candidateSkills.has(skill));
  const alreadyHave = candidate.skills.filter((skill) => teamSkills.has(skill));

  const coverageRatio = uncovered.length ? covers.length / uncovered.length : 0;
  const redundancyRatio = candidate.skills.length ? alreadyHave.length / candidate.skills.length : 0;

  const tzOverlapHours = team.members.length
    ? team.members.reduce((sum, m) => sum + overlapHours(m, candidate, context.at), 0) / team.members.length
    : 0;

  const teamRoles = new Set(team.members.map((m) => m.primaryRole).filter(Boolean));
  const fillsRole = candidate.primaryRole && !teamRoles.has(candidate.primaryRole) ? candidate.primaryRole : null;

  const recent =
    context.candidateUpdatedAt !== null && context.at.getTime() - context.candidateUpdatedAt.getTime() < RECENT_MS;

  const parts = {
    coverage: round(WEIGHTS.coverage * coverageRatio),
    redundancy: round(WEIGHTS.redundancy * redundancyRatio),
    tz: round(WEIGHTS.tz * Math.min(1, tzOverlapHours / FULL_TZ_SCORE_HOURS)),
    role: fillsRole ? WEIGHTS.role : 0,
    recency: recent ? WEIGHTS.recency : 0,
  };

  return {
    score: round(parts.coverage + parts.redundancy + parts.tz + parts.role + parts.recency),
    explanation: { covers, alreadyHave, tzOverlapHours: round(tzOverlapHours, 2), fillsRole, parts },
  };
}

/** Highest score first; id breaks ties, so results are stable and testable. */
export function rank<T extends { id: string; score: number }>(items: T[], limit: number): T[] {
  return [...items].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
