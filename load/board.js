// Run 1 of the load test: 100 virtual users reading the board, with random filters and cursors.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const DURATION = __ENV.DURATION || '3m';
const SKILLS = ['react', 'postgres', 'k8s', 'python', 'go', 'rust', 'figma', 'ml', 'aws', 'docker'];

export const options = {
  scenarios: {
    board: { executor: 'constant-vus', vus: 100, duration: DURATION },
  },
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const login = http.post(
    `${BASE}/api/auth/login`,
    JSON.stringify({ email: 'user9001@seed.local', password: 'demo-password-123' }),
    { headers: { 'content-type': 'application/json', 'x-requested-with': 'k6' } },
  );
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.body}`);
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  const hackathons = http.get(`${BASE}/api/hackathons`, { headers: { cookie } }).json('hackathons');
  return { cookie, hackathonId: hackathons[0].id };
}

export default function ({ cookie, hackathonId }) {
  const kind = Math.random() < 0.6 ? 'teams' : 'people';
  const params = [];
  if (Math.random() < 0.5) params.push(`skill=${SKILLS[Math.floor(Math.random() * SKILLS.length)]}`);
  const url = `${BASE}/api/hackathons/${hackathonId}/board/${kind}?${params.join('&')}`;
  const headers = { headers: { cookie }, tags: { name: `board/${kind}` } };

  const first = http.get(url, headers);
  check(first, { 'page 1 is 200': (r) => r.status === 200 });

  // Follow the keyset cursor some of the time, so deep pages are exercised too.
  const next = first.status === 200 ? first.json('nextCursor') : null;
  if (next && Math.random() < 0.5) {
    const second = http.get(`${url}&cursor=${next}`, headers);
    check(second, { 'page 2 is 200': (r) => r.status === 200 });
  }
}
