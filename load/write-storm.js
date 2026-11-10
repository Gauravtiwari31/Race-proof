// The chaos run's traffic. Every intent retries with the same Idempotency-Key until it gets a real
// answer, so a request killed with its replica must still complete exactly once on a survivor.
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://caddy';
const DURATION = __ENV.DURATION || '60s';
const retries = new Counter('retries_after_failure');
const gaveUp = new Counter('intents_abandoned');
const created = new Counter('teams_created');
const joined = new Counter('seats_taken');
const left = new Counter('leaves_completed');

export const options = {
  scenarios: { storm: { executor: 'constant-vus', vus: 30, duration: DURATION } },
  thresholds: {
    intents_abandoned: ['count==0'],
    // A storm that quietly does nothing must not pass: these prove real work happened under fire.
    teams_created: ['count>200'],
    seats_taken: ['count>100'],
    leaves_completed: ['count>200'],
  },
};

const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/[x]/g, () => Math.floor(Math.random() * 16).toString(16));

function call(method, url, body, cookie) {
  const params = {
    headers: {
      'x-requested-with': 'k6',
      cookie,
      'idempotency-key': uuid(),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    timeout: '10s',
    responseCallback: http.expectedStatuses({ min: 200, max: 499 }),
  };
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = http.request(method, url, body, params);
    if (res.status > 0 && res.status < 500) return res;
    retries.add(1);
    sleep(0.25);
  }
  gaveUp.add(1);
  return null;
}

function leaveCurrentTeam(hackathonId, cookie) {
  const me = http.get(`${BASE}/api/hackathons/${hackathonId}/me`, {
    headers: { cookie },
    responseCallback: http.expectedStatuses({ min: 200, max: 599 }),
  });
  if (me.status !== 200 || !me.json('teamId')) return;
  const res = call('POST', `${BASE}/api/teams/${me.json('teamId')}/leave`, null, cookie);
  if (res && res.status === 200) left.add(1);
}

export function setup() {
  // One leader and one dedicated joiner per VU, so every cycle really does take a seat.
  const cookies = [];
  for (let i = 0; i < 60; i++) {
    // Replicas are already being killed while this runs, so a login retries through a survivor.
    let res;
    for (let attempt = 0; attempt < 40; attempt++) {
      res = http.post(
        `${BASE}/api/auth/login`,
        JSON.stringify({ email: `user${9600 + i}@seed.local`, password: 'demo-password-123' }),
        { headers: { 'content-type': 'application/json', 'x-requested-with': 'k6' }, timeout: '10s' },
      );
      if (res.status > 0 && res.status < 500) break;
      sleep(0.25);
    }
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    cookies.push(res.headers['Set-Cookie'].split(';')[0]);
  }
  const hackathonId = http.get(`${BASE}/api/hackathons`, { headers: { cookie: cookies[0] } }).json('hackathons')[0].id;
  return { cookies, hackathonId };
}

export default function ({ cookies, hackathonId }) {
  const cookie = cookies[__VU - 1];
  const joiner = cookies[30 + __VU - 1];

  const team = call('POST', `${BASE}/api/hackathons/${hackathonId}/teams`, JSON.stringify({ name: `chaos-${uuid()}` }), cookie);
  if (!team) return;
  if (team.status !== 201) {
    // A killed request can leave this user seated from an earlier cycle. Get out and try again.
    leaveCurrentTeam(hackathonId, cookie);
    return;
  }
  created.add(1);
  const teamId = team.json('teamId');

  // The seat is taken through whichever replica is alive.
  const invite = call('POST', `${BASE}/api/teams/${teamId}/invites`, JSON.stringify({}), cookie);
  if (invite && invite.status === 201) {
    const redeem = call('POST', `${BASE}/api/invites/redeem`, JSON.stringify({ code: invite.json('code') }), joiner);
    if (redeem && redeem.status === 201) joined.add(1);
  }

  const leave = call('POST', `${BASE}/api/teams/${teamId}/leave`, null, cookie);
  if (leave && leave.status === 200) left.add(1);
  leaveCurrentTeam(hackathonId, joiner);
}
