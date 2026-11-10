// Run 2: reads stay fast while seats churn. 90 VUs read, 10 write, and 300 SSE streams stay open.
// Every write bumps the board version, so these reads are far colder than in board.js.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const DURATION = __ENV.DURATION || '3m';
const JSON_HEADERS = { 'content-type': 'application/json', 'x-requested-with': 'k6' };

export const options = {
  setupTimeout: '180s', // one Argon2 login per VU
  scenarios: {
    readers: { executor: 'constant-vus', vus: 90, duration: DURATION, exec: 'read' },
    writers: { executor: 'constant-vus', vus: 10, duration: DURATION, exec: 'write' },
    streams: { executor: 'constant-vus', vus: 300, duration: DURATION, exec: 'stream' },
  },
  thresholds: {
    'http_req_duration{scenario:readers}': ['p(95)<200'],
    'http_req_failed{scenario:streams}': ['rate<0.01'],
    'http_req_failed{scenario:readers}': ['rate<0.01'],
    'http_req_failed{scenario:writers}': ['rate<0.01'],
  },
};

function login(n) {
  const res = http.post(
    `${BASE}/api/auth/login`,
    JSON.stringify({ email: `user${n}@seed.local`, password: 'demo-password-123' }),
    { headers: JSON_HEADERS },
  );
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return res.headers['Set-Cookie'].split(';')[0];
}

export function setup() {
  // Users above 5,000 start with no team, so they are free to create and leave teams. __VU numbers
  // are shared across scenarios, so only one login per VU guarantees two writers never share a user.
  const writers = Array.from({ length: 400 }, (_, i) => login(9100 + i));
  const reader = login(9001);
  const hackathonId = http.get(`${BASE}/api/hackathons`, { headers: { cookie: reader } }).json('hackathons')[0].id;
  return { writers, reader, hackathonId };
}

export function read({ reader, hackathonId }) {
  const res = http.get(`${BASE}/api/hackathons/${hackathonId}/board/teams`, { headers: { cookie: reader } });
  check(res, { 'board is 200': (r) => r.status === 200 });
}

export function write({ writers, hackathonId }) {
  const cookie = writers[__VU - 1];
  const created = http.post(
    `${BASE}/api/hackathons/${hackathonId}/teams`,
    JSON.stringify({ name: `load-${__VU}-${__ITER}-${Date.now()}` }),
    { headers: { ...JSON_HEADERS, cookie } },
  );
  check(created, { 'team created': (r) => r.status === 201 });
  if (created.status !== 201) console.error(`create failed: ${created.status} ${created.body}`);
  if (created.status === 201) {
    // No content-type here: an empty body declared as JSON is correctly refused with a 400.
    const left = http.post(`${BASE}/api/teams/${created.json('teamId')}/leave`, null, {
      headers: { cookie, 'x-requested-with': 'k6' },
    });
    check(left, { 'team left': (r) => r.status === 200 });
  }
  sleep(0.2);
}

export function stream({ writers, hackathonId }) {
  // k6 has no SSE client; a long request with a timeout holds a real stream open for 30 seconds.
  // The API allows a few streams per account, as a browser needs, so the streams are spread over many
  // accounts. A refused stream backs off rather than retrying in a tight loop.
  const res = http.get(`${BASE}/api/events?hackathon=${hackathonId}`, {
    headers: { cookie: writers[(__VU - 1) % writers.length] },
    timeout: '30s',
    responseType: 'none',
    responseCallback: http.expectedStatuses(200, 0),
  });
  if (res.status !== 0 && res.status !== 200) sleep(5);
}
