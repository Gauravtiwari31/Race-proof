import React from 'react';
import {AbsoluteFill, Easing, interpolate, random, useCurrentFrame} from 'remotion';
import facts from '../../facts.json';
import terminal from './terminal.json';
import {Backdrop, C, Count, DISPLAY, Eyebrow, FPS, FlapText, MONO, Panel, Rise, SANS, Seat, Stamp, at, prog, spring, useProgress} from './kit';

type Scene = React.FC<{dur: number}>;

// ---- 1. cold open: fifty bots, one seat ------------------------------------------------------

/** Fifty bots rush one seat. The first to arrive takes it; the rest bounce off and turn into refusals. */
const Race: React.FC<{start: number; win: number; cx: number; cy: number}> = ({start, win, cx, cy}) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const bots = Array.from({length: 50}, (_, i) => {
    const angle = Math.PI * (0.08 + 0.84 * (i / 49)) + Math.PI;
    const r = 520 + random(`r${i}`) * 140;
    const delay = random(`d${i}`) * 0.25;
    const travel = i === 23 ? win - start - delay : win - start - delay + 0.05 + random(`a${i}`) * 0.5;
    return {i, x0: cx + Math.cos(angle) * r * 1.5, y0: cy + Math.sin(angle) * r * 0.75 + 120, delay, travel};
  });
  const seated = t >= win;
  return (
    <>
      {bots.map((b) => {
        const go = Math.min(1, Math.max(0, (t - start - b.delay) / b.travel));
        const k = Easing.in(Easing.cubic)(go);
        const arrived = go >= 1;
        const winner = b.i === 23;
        const lost = arrived && !winner;
        // Losers bounce back out along their path and settle as outlined refusals.
        const back = lost ? Easing.out(Easing.cubic)(Math.min(1, (t - start - b.delay - b.travel) / 0.6)) : 0;
        const along = k - back * (0.28 + random(`b${b.i}`) * 0.12);
        const x = b.x0 + (cx - b.x0) * along;
        const y = b.y0 + (cy - b.y0) * along;
        if (winner && arrived) return null;
        return (
          <div
            key={b.i}
            style={{
              position: 'absolute',
              left: x - 13,
              top: y - 13,
              width: 26,
              height: 26,
              borderRadius: 6,
              background: lost ? 'rgba(255,107,79,.12)' : C.inkSoft,
              border: lost ? `2px solid ${C.danger}` : 'none',
              opacity: t < start + b.delay ? 0 : 1,
            }}
          />
        );
      })}
      <div style={{position: 'absolute', left: cx - 70, top: cy - 76}}>
        <Seat size={150} empty={!seated} fill={C.accent} color={C.onAccent} label={seated ? 'WIN' : ''} style={{transform: `scale(${seated ? 1 + 0.12 * Math.max(0, 1 - (t - win) * 4) : 1})`}} />
      </div>
    </>
  );
};

export const Cold: Scene = () => {
  const frame = useCurrentFrame();
  const fifty = at('cold', 'fifty');
  const lift = prog(frame, fifty - 0.4, 0.7);
  return (
    <Backdrop>
      <AbsoluteFill style={{alignItems: 'center', paddingTop: interpolate(lift, [0, 1], [250, 90])}}>
        <div style={{display: 'flex', flexDirection: 'column', gap: 26, alignItems: 'flex-start', transform: `scale(${1 - lift * 0.42})`, transformOrigin: 'top center'}}>
          <FlapText text="10000 PEOPLE" start={at('cold', 'Ten') - 0.1} size={110} seed="a" />
          <FlapText text="1 HACKATHON" start={at('cold', 'hackathon') - 0.3} size={110} seed="b" />
          <FlapText text="1 LAST SEAT" start={at('cold', 'last') - 0.3} size={110} color={C.accent} seed="c" />
        </div>
      </AbsoluteFill>
      {frame / FPS > fifty - 0.2 && <Race start={fifty - 0.1} win={at('cold', 'exactly')} cx={960} cy={720} />}
    </Backdrop>
  );
};

// ---- 2. title --------------------------------------------------------------------------------

export const Title: Scene = () => {
  const start = at('title', 'This');
  const tag = useProgress(at('title', 'Race'), 0.6);
  const logo = useProgress(start - 0.15, 0.5, spring);
  return (
    <Backdrop glow="rgba(255,178,36,0.12)">
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 50}}>
        <div style={{transform: `scale(${logo})`, opacity: logo}}>
          <Seat size={140} fill={C.accent} />
        </div>
        <div style={{display: 'flex', gap: 40}}>
          <FlapText text="LAST" start={start + 0.1} size={190} seed="t1" />
          <FlapText text="SEAT" start={start + 0.3} size={190} color={C.accent} seed="t2" />
        </div>
        <div style={{opacity: tag, transform: `translateY(${(1 - tag) * 20}px)`, textAlign: 'center'}}>
          <Eyebrow size={30} color={C.inkSoft}>Race-proof team formation</Eyebrow>
          <div style={{fontFamily: SANS, fontSize: 34, color: C.mute, marginTop: 16}}>The database decides every seat.</div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---- 5. the statement ------------------------------------------------------------------------

const SQL = [
  ['UPDATE', ' teams'],
  ['   SET', ' member_count = member_count + 1,'],
  ['', '       version = version + 1'],
  [' WHERE', ' id = $1'],
  ['   AND', ' member_count < max_size'],
  ['RETURNING', ' member_count;'],
];

const Code: React.FC<{start: number; highlight: number}> = ({start, highlight}) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const hi = prog(frame, highlight, 0.4);
  return (
    <Panel style={{width: 860, padding: '34px 40px'}}>
      <Eyebrow>apps/api/src/modules/teams/service.ts · takeSeat()</Eyebrow>
      <div style={{marginTop: 26, fontFamily: MONO, fontSize: 32, lineHeight: 1.65}}>
        {SQL.map(([kw, rest], i) => {
          const show = t >= start + i * 0.18;
          const isWhere = i === 4;
          return (
            <div
              key={i}
              style={{
                opacity: show ? 1 : 0,
                transform: `translateX(${show ? 0 : -12}px)`,
                whiteSpace: 'pre',
                background: isWhere ? `rgba(255,178,36,${0.16 * hi})` : 'transparent',
                boxShadow: isWhere ? `inset 4px 0 0 rgba(255,178,36,${hi})` : 'none',
                margin: '0 -40px',
                padding: '0 40px',
              }}
            >
              <span style={{color: C.accent}}>{kw}</span>
              <span style={{color: isWhere ? C.ink : C.inkSoft}}>{rest}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
};

/** Requests queue on the row lock; the first commits, the rest re-check the WHERE and update 0 rows. */
const LockQueue: React.FC<{queue: number; win: number; rest: number}> = ({queue, win, rest}) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const n = 9;
  const qp = prog(frame, queue, 0.8);
  const count = t >= win + 0.3 ? 4 : 3;
  return (
    <div style={{width: 760, position: 'relative'}}>
      <Panel style={{padding: '28px 32px'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <Eyebrow>Row lock · teams.id = 42</Eyebrow>
          <div style={{display: 'flex', alignItems: 'baseline', gap: 12}}>
            <Eyebrow>member_count</Eyebrow>
            <FlapText key={count} text={`${count}/4`} start={count === 4 ? win + 0.3 : -1} size={46} color={count === 4 ? C.accent : C.ink} spin={0.3} seed="mc" />
          </div>
        </div>
        <div style={{marginTop: 26, display: 'flex', flexDirection: 'column', gap: 12}}>
          {Array.from({length: n}, (_, i) => {
            const label = i === n - 1 ? '… 41 more' : `bot ${String(i + 7).padStart(2, '0')}`;
            const isWinner = i === 0;
            const refusedAt = rest + (i - 1) * 0.22;
            const refused = !isWinner && i < n - 1 && t >= refusedAt;
            const done = isWinner && t >= win;
            const slide = interpolate(qp, [0, 1], [380, 0]) + i * 20 * (1 - qp);
            return (
              <div key={i} style={{display: 'flex', alignItems: 'center', gap: 18, opacity: Math.min(1, qp * 1.4), transform: `translateX(${slide}px)`}}>
                <div style={{width: 130, fontFamily: MONO, fontSize: 22, color: C.mute}}>{label}</div>
                <div style={{flex: 1, height: 34, borderRadius: 8, background: done ? C.accent : refused ? 'rgba(255,107,79,.12)' : C.raised, border: refused ? `2px solid ${C.danger}` : `1px solid ${C.lineSoft}`, display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: MONO, fontSize: 20, color: done ? C.onAccent : refused ? C.danger : C.mute}}>
                  {i === n - 1 ? 'waiting on the lock' : done ? 'UPDATE 1 · COMMIT · 201' : refused ? 'WHERE re-checked → UPDATE 0 · 409 TEAM_FULL' : 'waiting on the lock'}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
};

export const Statement: Scene = () => {
  const frame = useCurrentFrame();
  const keys = useProgress(at('sql', 'primary'), 0.5);
  const fade = 1 - prog(frame, at('sql', 'primary') - 0.3, 0.4);
  return (
    <Backdrop>
      <AbsoluteFill style={{padding: '130px 90px 0', flexDirection: 'row', gap: 60, alignItems: 'flex-start', justifyContent: 'center'}}>
        <div style={{display: 'flex', flexDirection: 'column', gap: 30}}>
          <Rise at={0.1}>
            <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 92, color: C.ink, textTransform: 'uppercase', lineHeight: 0.95}}>
              One statement.
              <br />
              <span style={{color: C.accent}}>No gap.</span>
            </div>
          </Rise>
          <Code start={at('sql', 'Update')} highlight={at('sql', 'where')} />
        </div>
        <div style={{opacity: fade, marginTop: 40}}>
          <LockQueue queue={at('sql', 'Racers')} win={at('sql', 'winner')} rest={at('sql', 'everyone')} />
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'flex-end', padding: '0 90px 200px', opacity: keys}}>
        <div style={{display: 'flex', flexDirection: 'column', gap: 18, width: 760, transform: `translateY(${(1 - keys) * 30}px)`}}>
          {[
            ['PRIMARY KEY (hackathon_id, user_id)', 'one team per person', at('sql', 'primary')],
            ["UNIQUE INDEX … WHERE role = 'leader'", 'exactly one leader', at('sql', 'partial')],
            ['CHECK (member_count BETWEEN 0 AND max_size)', 'last line of defence', at('sql', 'partial') + 0.6],
          ].map(([code, why, when]) => (
            <Rise key={code as string} at={when as number} dy={16}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: C.surface, border: `1px solid ${C.lineSoft}`, borderLeft: `4px solid ${C.accent}`, borderRadius: 12, padding: '16px 22px'}}>
                <span style={{fontFamily: MONO, fontSize: 22, color: C.ink}}>{code}</span>
                <span style={{fontFamily: MONO, fontSize: 18, letterSpacing: '0.12em', color: C.accent, textTransform: 'uppercase'}}>{why}</span>
              </div>
            </Rise>
          ))}
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---- 6. the tests, green and then red ---------------------------------------------------------

type Line = {text: string; tone?: 'ok' | 'bad' | 'mute' | 'cmd' | 'head'};
const toneColor = {ok: C.live, bad: C.danger, mute: C.mute, cmd: C.accent, head: C.ink};

const Term: React.FC<{lines: Line[]; start: number; step?: number; title: string; tint?: string; width?: number}> = ({lines, start, step = 0.11, title, tint = C.lineSoft, width = 860}) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  return (
    <div style={{width, borderRadius: 16, overflow: 'hidden', border: `1px solid ${tint}`, background: '#0a0a09', boxShadow: '0 30px 80px rgba(0,0,0,.6)'}}>
      <div style={{height: 42, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', background: '#121210', borderBottom: `1px solid ${C.lineSoft}`}}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.8}} />)}
        <div style={{marginLeft: 12, fontFamily: MONO, fontSize: 16, color: C.mute}}>{title}</div>
      </div>
      <div style={{padding: '22px 26px', fontFamily: MONO, fontSize: 21, lineHeight: 1.55, minHeight: 420}}>
        {lines.map((l, i) => {
          const show = t >= start + i * step;
          if (!show) return null;
          return <div key={i} style={{whiteSpace: 'pre-wrap', color: toneColor[l.tone ?? 'head'] ?? C.ink}}>{l.text}</div>;
        })}
      </div>
    </div>
  );
};

export const Tests: Scene = () => {
  const frame = useCurrentFrame();
  const red = at('tests', 'mutation');
  const goesRed = at('tests', 'red');
  const flash = interpolate(frame / FPS, [goesRed, goesRed + 0.15, goesRed + 0.9], [0, 0.22, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const barrier = useProgress(at('tests', 'barrier'), 0.4);
  const twenty = at('tests', 'twenty');
  return (
    <Backdrop>
      <AbsoluteFill style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 50, padding: '60px 70px 80px'}}>
        <div style={{display: 'flex', flexDirection: 'column', gap: 22}}>
          <Rise at={0.1}>
            <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 84, textTransform: 'uppercase', lineHeight: 0.95, color: C.ink}}>
              Proven, <span style={{color: C.accent}}>not promised.</span>
            </div>
          </Rise>
          <Term title="apps/api · vitest" lines={terminal.green as Line[]} start={at('tests', 'race') - 0.1} step={0.12} />
          <div style={{display: 'flex', gap: 14, opacity: barrier}}>
            {['50 keep-alive connections', 'one shared barrier', `20 runs`, '2 API processes'].map((label, i) => (
              <Stamp key={label} at={[at('tests', 'fifty'), at('tests', 'barrier'), twenty, at('tests', 'two')][i]} rotate={0} style={{position: 'relative', fontSize: 26, padding: '6px 14px 2px', borderWidth: 3}}>
                {label}
              </Stamp>
            ))}
          </div>
        </div>
        <Rise at={red - 0.2}>
          <Term title="mutation check · naive seat swapped in" lines={terminal.red as Line[]} start={red} step={0.09} tint={C.danger} width={820} />
        </Rise>
      </AbsoluteFill>
      <AbsoluteFill style={{background: C.danger, opacity: flash, pointerEvents: 'none'}} />
    </Backdrop>
  );
};

// ---- 9. idempotency ----------------------------------------------------------------------------

export const Idempotency: Scene = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const first = at('idem', 'Every');
  const commit = at('idem', 'committed');
  const retry = at('idem', 'retry');
  const lane = (y: number, label: string) => (
    <div style={{position: 'absolute', left: 0, top: y, display: 'flex', alignItems: 'center', gap: 18}}>
      <Eyebrow style={{width: 160}}>{label}</Eyebrow>
    </div>
  );
  const travel = (start: number, from: number, to: number) => interpolate(t, [start, start + 0.7], [from, to], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic)});
  const req = (start: number, label: string, tone: string) => {
    const x = travel(start, 0, 560);
    const show = t >= start;
    return (
      <div style={{position: 'absolute', left: 200 + x, top: 120, opacity: show ? 1 : 0, background: C.raised, border: `2px solid ${tone}`, borderRadius: 12, padding: '12px 18px', fontFamily: MONO, fontSize: 20, color: C.ink, whiteSpace: 'nowrap'}}>
        {label}
      </div>
    );
  };
  const rows = prog(frame, commit, 0.5);
  const replay = prog(frame, retry + 0.8, 0.4);
  return (
    <Backdrop>
      <AbsoluteFill style={{padding: '150px 140px'}}>
        <Rise at={0.1}>
          <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 84, textTransform: 'uppercase', color: C.ink, lineHeight: 0.95}}>
            Retry all you like. <span style={{color: C.accent}}>It happens once.</span>
          </div>
        </Rise>
        <div style={{position: 'relative', marginTop: 70, height: 520}}>
          {lane(130, 'Browser')}
          {req(first, 'POST /invites/redeem · Idempotency-Key: 7f3a…', C.accent)}
          {req(retry, 'POST /invites/redeem · Idempotency-Key: 7f3a…  (retry)', C.blue)}
          <div style={{position: 'absolute', left: 900, top: 230, width: 740}}>
            <Panel style={{padding: 28, opacity: prog(frame, first + 0.5, 0.4)}}>
              <Eyebrow>One Postgres transaction</Eyebrow>
              <div style={{display: 'flex', flexDirection: 'column', gap: 12, marginTop: 18, opacity: rows}}>
                {['memberships  + (team 42, ananya)', 'teams        member_count 3 → 4', 'audit_events + member.joined', 'idempotency_keys + 7f3a → 201 {teamId}'].map((r) => (
                  <div key={r} style={{fontFamily: MONO, fontSize: 21, color: C.inkSoft, background: C.raised, borderRadius: 8, padding: '8px 14px', whiteSpace: 'pre'}}>{r}</div>
                ))}
              </div>
              <div style={{marginTop: 16, fontFamily: MONO, fontSize: 22, color: C.live, opacity: rows}}>COMMIT</div>
            </Panel>
          </div>
          <div style={{position: 'absolute', left: 200, top: 420, opacity: replay, transform: `translateY(${(1 - replay) * 20}px)`, display: 'flex', gap: 22, alignItems: 'center'}}>
            <div style={{fontFamily: MONO, fontSize: 24, color: C.blue, border: `2px solid ${C.blue}`, borderRadius: 12, padding: '10px 18px'}}>← 201 replayed from 7f3a</div>
            <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 48, color: C.ink, textTransform: 'uppercase'}}>joins: <span style={{color: C.accent}}>1</span></div>
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---- 11. security --------------------------------------------------------------------------------

const Card: React.FC<{at: number; title: string; body: string; code?: string}> = ({at: when, title, body, code}) => (
  <Rise at={when} dy={24}>
    <div style={{width: 520, height: 230, background: C.surface, border: `1px solid ${C.lineSoft}`, borderTop: `4px solid ${C.accent}`, borderRadius: 18, padding: '26px 30px', boxSizing: 'border-box'}}>
      <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 46, color: C.ink, textTransform: 'uppercase', lineHeight: 1}}>{title}</div>
      <div style={{fontFamily: SANS, fontSize: 26, color: C.inkSoft, marginTop: 12, lineHeight: 1.3}}>{body}</div>
      {code && <div style={{fontFamily: MONO, fontSize: 19, color: C.accent, marginTop: 12}}>{code}</div>}
    </div>
  </Rise>
);

export const Security: Scene = () => (
  <Backdrop>
    <AbsoluteFill style={{padding: '140px 120px', gap: 46}}>
      <Rise at={0.1}>
        <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 84, textTransform: 'uppercase', color: C.ink, lineHeight: 0.95}}>
          Secure <span style={{color: C.accent}}>by construction</span>
        </div>
      </Rise>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 520px)', gap: 30}}>
        <Card at={at('security', 'leader')} title="Leader only" body="Accept, decline and remove check the role after the row lock." code="race.stale-leader-check" />
        <Card at={at('security', 'demoted')} title="No stale authority" body="A leader demoted while a request waits is refused." code="new statement, fresh snapshot" />
        <Card at={at('security', 'fifty')} title="50-bit codes" body="Crockford base32, shown once, stored only as a SHA-256 hash." code="TEAM-7KQ2-M9XD-H4" />
        <Card at={at('security', 'expire')} title="They expire" body="Expiry, revocation and max uses re-checked after the lock." />
        <Card at={at('security', 'ten')} title="10 guesses / 10 min" body="Per person and per address, durable in Postgres, shared by replicas." />
        <Card at={at('security', 'validated')} title="Validated" body="Zod on every body, query and param. Argon2id passwords." code="400 VALIDATION" />
      </div>
    </AbsoluteFill>
  </Backdrop>
);

// ---- 14. load --------------------------------------------------------------------------------

export const Load: Scene = () => {
  const frame = useCurrentFrame();
  const p95 = facts.p95;
  const bar = prog(frame, at('load', 'ninety') + 0.2, 1.0, Easing.out(Easing.cubic));
  const budget = prog(frame, at('load', 'budget'), 0.5);
  return (
    <Backdrop>
      <AbsoluteFill style={{padding: '140px 140px', gap: 60}}>
        <Rise at={0.1}>
          <Eyebrow size={26}>k6 · 100 virtual users · board endpoint · {facts.duration}</Eyebrow>
        </Rise>
        <div style={{display: 'flex', gap: 100, alignItems: 'flex-end'}}>
          <div>
            <Eyebrow>p95 latency</Eyebrow>
            <div style={{marginTop: 10}}>
              <Count at={at('load', 'ninety')} to={p95} decimals={1} size={260} suffix=" ms" />
            </div>
          </div>
          <div style={{display: 'flex', flexDirection: 'column', gap: 18, paddingBottom: 30}}>
            {[
              ['10,000', 'users seeded', at('load', 'ten')],
              ['2,000', 'teams', at('load', 'two')],
              [facts.requests, `requests, ${facts.failures} failed`, at('load', 'hundred')],
            ].map(([n, label, when]) => (
              <Rise key={label as string} at={when as number} dy={14}>
                <div style={{display: 'flex', gap: 18, alignItems: 'baseline'}}>
                  <span style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 64, color: C.ink}}>{n}</span>
                  <span style={{fontFamily: SANS, fontSize: 30, color: C.mute}}>{label}</span>
                </div>
              </Rise>
            ))}
          </div>
        </div>
        <div style={{position: 'relative', width: 1640, height: 70, marginTop: 20}}>
          <div style={{position: 'absolute', inset: 0, borderRadius: 12, background: C.surface, border: `1px solid ${C.lineSoft}`}} />
          <div style={{position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(p95 / 200) * 100 * bar}%`, borderRadius: 12, background: C.accent}} />
          <div style={{position: 'absolute', right: 0, top: -50, opacity: budget, fontFamily: MONO, fontSize: 24, color: C.inkSoft}}>budget 200 ms</div>
          <div style={{position: 'absolute', right: -2, top: -14, bottom: -14, width: 4, background: C.danger, opacity: budget}} />
          <div style={{position: 'absolute', left: 0, top: 90, fontFamily: MONO, fontSize: 22, color: C.mute, opacity: budget}}>
            {Math.round((p95 / 200) * 100)}% of the budget used · local Compose, two replicas behind Caddy
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---- 15. chaos -------------------------------------------------------------------------------

export const Chaos: Scene = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const start = at('chaos', 'killed');
  const kills = facts.kills;
  // A replica drops roughly every 0.55 s of film, alternating, until the count is reached.
  const killTimes = Array.from({length: kills}, (_, i) => start + 0.1 + i * 0.5);
  const down = (r: number) => killTimes.some((k, i) => i % 2 === r && t >= k && t < k + 0.32);
  const killed = killTimes.filter((k) => t >= k).length;
  const seats = Math.round(facts.seats * Math.min(1, Math.max(0, (t - start) / (killTimes[killTimes.length - 1] - start + 0.4))));
  const zero = useProgress(at('chaos', 'Zero'), 0.4, spring);
  return (
    <Backdrop glow="rgba(255,107,79,0.06)">
      <AbsoluteFill style={{padding: '140px 140px', gap: 60}}>
        <Rise at={0.1}>
          <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 84, textTransform: 'uppercase', color: C.ink, lineHeight: 0.95}}>
            Kill it <span style={{color: C.danger}}>mid-join.</span>
          </div>
        </Rise>
        <div style={{display: 'flex', gap: 40}}>
          {['api-a', 'api-b'].map((name, r) => (
            <div key={name} style={{width: 360, height: 170, borderRadius: 18, background: down(r) ? 'rgba(255,107,79,.14)' : C.surface, border: `2px solid ${down(r) ? C.danger : C.lineSoft}`, padding: 26, boxSizing: 'border-box'}}>
              <Eyebrow>{name}</Eyebrow>
              <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 60, marginTop: 10, color: down(r) ? C.danger : C.live, textTransform: 'uppercase'}}>{down(r) ? 'SIGKILL' : 'serving'}</div>
            </div>
          ))}
          <div style={{width: 360, height: 170, borderRadius: 18, background: C.surface, border: `2px solid ${C.lineSoft}`, padding: 26, boxSizing: 'border-box'}}>
            <Eyebrow>postgres</Eyebrow>
            <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 60, marginTop: 10, color: C.ink, textTransform: 'uppercase'}}>rolls back</div>
          </div>
        </div>
        <div style={{display: 'flex', gap: 120}}>
          {[
            ['Replica kills', String(killed), C.ink],
            ['Seats taken', seats.toLocaleString('en-US'), C.ink],
          ].map(([label, value, color]) => (
            <div key={label}>
              <Eyebrow>{label}</Eyebrow>
              <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 150, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums'}}>{value}</div>
            </div>
          ))}
          <div style={{opacity: zero, transform: `scale(${0.7 + 0.3 * zero})`, transformOrigin: 'left bottom'}}>
            <Eyebrow>Invariant violations</Eyebrow>
            <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 150, color: C.live, lineHeight: 1}}>0</div>
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---- 16. CI ----------------------------------------------------------------------------------

export const Ci: Scene = () => {
  const steps = [
    ['pnpm typecheck', 0.2],
    ['pnpm build', 0.45],
    [`pnpm test · ${facts.apiTests} API tests on real Postgres`, at('ci', 'API')],
    [`pnpm e2e · ${facts.e2eTests} browser tests, keyboard-only and axe`, at('ci', 'browser')],
  ] as const;
  return (
    <Backdrop>
      <AbsoluteFill style={{padding: '150px 160px', gap: 50}}>
        <Rise at={0.1}>
          <Eyebrow size={26}>GitHub Actions · on every push</Eyebrow>
        </Rise>
        <div style={{display: 'flex', gap: 120, alignItems: 'flex-end'}}>
          <div>
            <Count at={at('ci', 'API') - 0.6} to={facts.apiTests} size={240} color={C.ink} />
            <Eyebrow>API tests</Eyebrow>
          </div>
          <div>
            <Count at={at('ci', 'browser') - 0.4} to={facts.e2eTests} size={240} color={C.ink} />
            <Eyebrow>browser tests</Eyebrow>
          </div>
        </div>
        <Panel style={{width: 1300, padding: '26px 34px', display: 'flex', flexDirection: 'column', gap: 16}}>
          {steps.map(([label, when]) => (
            <Rise key={label} at={when} dy={10} dur={0.4}>
              <div style={{display: 'flex', alignItems: 'center', gap: 18, fontFamily: MONO, fontSize: 26, color: C.inkSoft}}>
                <span style={{width: 32, height: 32, borderRadius: 16, background: C.live, color: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700}}>✓</span>
                {label}
              </div>
            </Rise>
          ))}
        </Panel>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---- 17. trade-offs and next week ------------------------------------------------------------

const BoardRow: React.FC<{at: number; cols: string[]; status: string; tone?: string; seed: string}> = ({at: when, cols, status, tone = C.accent, seed}) => (
  <Rise at={when} dy={10} dur={0.35}>
    <div style={{display: 'grid', gridTemplateColumns: '560px 640px 300px', alignItems: 'center', gap: 30, padding: '16px 24px', borderBottom: `1px solid ${C.lineSoft}`}}>
      <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 40, color: C.ink, textTransform: 'uppercase'}}>{cols[0]}</div>
      <div style={{fontFamily: SANS, fontSize: 27, color: C.inkSoft}}>{cols[1]}</div>
      <FlapText text={status} start={when + 0.15} size={30} color={tone} spin={0.35} stagger={0.02} seed={seed} />
    </div>
  </Rise>
);

export const Tradeoffs: Scene = () => {
  const frame = useCurrentFrame();
  const next = at('tradeoffs', 'week');
  const swap = prog(frame, next - 0.6, 0.4);
  return (
    <Backdrop>
      <AbsoluteFill style={{padding: '140px 120px'}}>
        <div style={{position: 'relative'}}>
          <div style={{opacity: 1 - swap, position: 'absolute', inset: 0}}>
            <Eyebrow size={26}>Decisions · why · cost</Eyebrow>
            <div style={{marginTop: 30, borderTop: `1px solid ${C.line}`}}>
              <BoardRow at={at('tradeoffs', 'denormalised')} cols={['Denormalised count', 'Board reads never count rows; one transaction keeps it true']} status="CHECKED" seed="r1" />
              <BoardRow at={at('tradeoffs', 'Server')} cols={['Server-sent events', 'Updates flow one way; reconnect and resume come free']} status="ON TIME" seed="r2" />
              <BoardRow at={at('tradeoffs', 'Postgres')} cols={['Postgres rate limits', 'Durable and shared by replicas; a write per attempt']} status="ON TIME" seed="r3" />
            </div>
          </div>
          <div style={{opacity: swap}}>
            <Eyebrow size={26} color={C.accent}>With one more week</Eyebrow>
            <div style={{marginTop: 30, borderTop: `1px solid ${C.line}`}}>
              <BoardRow at={at('tradeoffs', 'commit')} cols={['Commit-ordered event log', 'Logical replication instead of id order']} status="SCHEDULED" tone={C.live} seed="n1" />
              <BoardRow at={at('tradeoffs', 'waitlists')} cols={['Waitlist and seat holds', 'Offer a freed seat with a timed hold']} status="SCHEDULED" tone={C.live} seed="n2" />
              <BoardRow at={at('tradeoffs', 'organiser')} cols={['Organiser console', 'Create hackathons, set sizes, export teams']} status="SCHEDULED" tone={C.live} seed="n3" />
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---- 18. close -------------------------------------------------------------------------------

export const Close: Scene = () => {
  const frame = useCurrentFrame();
  const out = prog(frame, at('close', 'Last') - 0.2, 0.5);
  const links = useProgress(at('close', 'Last') + 0.5, 0.6);
  return (
    <Backdrop glow="rgba(255,178,36,0.12)">
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 28, opacity: 1 - out}}>
        <FlapText text="FIFTY CLICKS" start={at('close', 'Fifty') - 0.1} size={120} seed="c1" />
        <FlapText text="ONE SEAT" start={at('close', 'One') - 0.1} size={120} seed="c2" />
        <FlapText text="EXACTLY ONE WINNER" start={at('close', 'Exactly') - 0.1} size={120} color={C.accent} seed="c3" />
      </AbsoluteFill>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', gap: 40, opacity: out}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 40}}>
          <Seat size={150} fill={C.accent} />
          <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 220, color: C.ink, textTransform: 'uppercase', lineHeight: 0.9}}>
            Last<span style={{color: C.accent}}>seat</span>
          </div>
        </div>
        <div style={{opacity: links, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14}}>
          <Eyebrow size={28} color={C.inkSoft}>Race-proof team formation · PS1 · Hack4Hack 2026</Eyebrow>
          <div style={{fontFamily: MONO, fontSize: 30, color: C.mute}}>{facts.repo}</div>
          <div style={{fontFamily: MONO, fontSize: 30, color: C.accent}}>{facts.live}</div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
