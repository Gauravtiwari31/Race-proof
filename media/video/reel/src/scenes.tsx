import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import facts from '../../facts.json';
import footage from '../public/footage/info.json';
import {Chaos, Ci, Close, Cold, Idempotency, Load, Security, Statement, Tests, Title, Tradeoffs} from './graphics';
import {Backdrop, Browser, C, DISPLAY, Eyebrow, FPS, Phone, Rise, Stamp, Who, at, prog} from './kit';

type Scene = React.FC<{dur: number}>;
type Clip = {duration: number; marks: Record<string, number>; t0: number};
const clips = footage as Record<string, Clip>;

/**
 * Where to start a clip, and how fast to play it, so that `mark` in the footage lands on `cue` in the scene
 * and the footage lasts until the scene ends. Footage is only ever sped up, never slowed below real time.
 */
function sync(clip: string, mark: string | null, cue: number, dur: number, maxRate = 2.2) {
  const c = clips[clip];
  const m = mark ? c.marks[mark] : 0;
  let rate = 1;
  // If what follows the mark is longer than the rest of the scene, play a little faster to fit.
  const after = c.duration - m;
  if (after > dur - cue) rate = Math.min(maxRate, after / Math.max(0.5, dur - cue));
  const from = Math.max(0, m - cue * rate);
  return {from, rate};
}

/** A heading that sits above footage. */
const Head: React.FC<{eyebrow: string; title: React.ReactNode}> = ({eyebrow, title}) => (
  <Rise at={0.05} dy={20}>
    <Eyebrow size={22} color={C.accent}>{eyebrow}</Eyebrow>
    <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 64, color: C.ink, textTransform: 'uppercase', lineHeight: 1, marginTop: 8}}>{title}</div>
  </Rise>
);

/** One browser, centred, with a heading on the left and stamps on the right. */
const Single: React.FC<{
  clip: string;
  mark: string | null;
  cue: number;
  dur: number;
  eyebrow: string;
  title: React.ReactNode;
  url: string;
  stamps?: {at: number; text: string; color?: string}[];
  camera?: {t: number; zoom: number; x: number; y: number}[];
}> = ({clip, mark, cue, dur, eyebrow, title, url, stamps = [], camera}) => {
  const {from, rate} = sync(clip, mark, cue, dur);
  return (
    <Backdrop>
      <AbsoluteFill style={{padding: '96px 70px 120px', flexDirection: 'row', gap: 46, alignItems: 'center'}}>
        <div style={{width: 380, display: 'flex', flexDirection: 'column', gap: 30, alignSelf: 'flex-start', marginTop: 40}}>
          <Head eyebrow={eyebrow} title={title} />
          <div style={{position: 'relative', display: 'flex', flexDirection: 'column', gap: 22}}>
            {stamps.map((s) => (
              <div key={s.text} style={{position: 'relative', height: 70}}>
                <Stamp at={s.at} color={s.color} rotate={-2} style={{left: 0, top: 0, fontSize: 34}}>{s.text}</Stamp>
              </div>
            ))}
          </div>
        </div>
        <Browser clip={clip} from={from} rate={rate} url={url} width={1360} camera={camera} />
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---- the race, in the real app ---------------------------------------------------------------

const Arena: Scene = ({dur}) => (
  <Single
    clip="arena"
    mark="click"
    cue={at('arena', 'Fifty') - 0.3}
    dur={dur}
    eyebrow="Race Arena · real transactions"
    title={<>50 bots.<br /><span style={{color: C.accent}}>1 seat.</span></>}
    url="lastseat.app/arena"
    stamps={[
      {at: at('arena', 'winner'), text: '1 winner'},
      {at: at('arena', 'refusals'), text: '49 × 409 team full', color: C.danger},
    ]}
  />
);

const Naive: Scene = ({dur}) => (
  <Single
    clip="naive"
    mark="click"
    cue={at('naive', 'Same')}
    dur={dur}
    eyebrow="Naive mode · read, then write"
    title={<>The bug most<br /><span style={{color: C.danger}}>apps ship.</span></>}
    url="lastseat.app/arena"
    stamps={[
      {at: at('naive', 'people'), text: `${facts.naiveWinners} winners`, color: C.danger},
      {at: at('naive', 'matches'), text: 'count ≠ members', color: C.danger},
    ]}
  />
);

// ---- the product -----------------------------------------------------------------------------

/** Two people, two browsers, one database: their clips were filmed at the same moment. */
const Flow: Scene = ({dur}) => {
  const a = clips.flow_ananya;
  const r = clips.flow_rohan;
  const rate = Math.min(2.4, Math.max(1, a.duration / (dur - 0.4)));
  const lag = r.t0 - a.t0; // Rohan's first frame, in Ananya's clip time
  const w = 860;
  return (
    <Backdrop>
      <AbsoluteFill style={{padding: '110px 60px 0', alignItems: 'center', gap: 26}}>
        <Head eyebrow="Two browsers · live over server-sent events" title={<>Create. Ask. Accept. <span style={{color: C.accent}}>Live.</span></>} />
        <div style={{display: 'flex', gap: 50}}>
          <div>
            <Browser clip="flow_ananya" rate={rate} url="lastseat.app/teams/chai-and-commits" width={w} aspect={1024 / 700} />
            <Who name="Ananya Iyer" role="leader · frontend" />
          </div>
          <div>
            <Browser clip="flow_rohan" from={Math.max(0, -lag)} rate={rate} url="lastseat.app" width={w} aspect={1024 / 700} />
            <Who name="Rohan Mehta" role="looking · backend" color={C.inkSoft} />
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

const Rollback: Scene = ({dur}) => (
  <Single
    clip="rollback"
    mark="click"
    cue={at('rollback', 'appears') - 0.2}
    dur={dur}
    eyebrow="Optimistic UI · honest rollback"
    title={<>Instant.<br /><span style={{color: C.accent}}>And truthful.</span></>}
    url="lastseat.app/teams/chai-and-commits"
    stamps={[
      {at: at('rollback', 'faster'), text: '409 team full', color: C.danger},
      {at: at('rollback', 'why'), text: 'rolled back + reason'},
    ]}
    camera={[
      {t: 0, zoom: 1, x: 0.5, y: 0.4},
      {t: at('rollback', 'appears') - 0.4, zoom: 1.35, x: 0.3, y: 0.35},
      {t: at('rollback', 'why') + 1.2, zoom: 1.35, x: 0.3, y: 0.35},
      {t: at('rollback', 'why') + 2, zoom: 1, x: 0.5, y: 0.4},
    ]}
  />
);

const Rules: Scene = ({dur}) => (
  <Single
    clip="rules"
    mark="left"
    cue={at('rules', 'leader') + 0.2}
    dur={dur}
    eyebrow="Leave · promote · delete · audit"
    title={<>The rules,<br /><span style={{color: C.accent}}>in one transaction.</span></>}
    url="lastseat.app/teams/chai-and-commits"
    stamps={[
      {at: at('rules', 'takes'), text: 'Rohan → leader'},
      {at: at('rules', 'deleted'), text: 'last out = team deleted'},
      {at: at('rules', 'machine'), text: 'audit time machine'},
    ]}
  />
);

const Suggest: Scene = ({dur}) => (
  <Single
    clip="suggest"
    mark={null}
    cue={0}
    dur={dur}
    eyebrow="Teammate suggestions"
    title={<>Ranked,<br /><span style={{color: C.accent}}>and explained.</span></>}
    url="lastseat.app/suggestions"
    stamps={[
      {at: at('suggest', 'skills'), text: 'missing skills'},
      {at: at('suggest', 'overlap'), text: 'time-zone overlap'},
      {at: at('suggest', 'explained'), text: 'score breakdown'},
    ]}
  />
);

const Access: Scene = ({dur}) => {
  const frame = useCurrentFrame();
  const kb = at('access', 'keyboard');
  const phone = sync('phone', null, 0, dur);
  const keys = sync('keyboard', null, kb - 0.6, dur);
  const fade = prog(frame, kb - 0.8, 0.5);
  return (
    <Backdrop>
      <AbsoluteFill style={{padding: '110px 90px 120px', flexDirection: 'row', gap: 70, alignItems: 'center', justifyContent: 'center'}}>
        <div style={{display: 'flex', flexDirection: 'column', gap: 30, width: 380, alignSelf: 'flex-start', marginTop: 40}}>
          <Head eyebrow="Phone · keyboard · axe" title={<>For every<br /><span style={{color: C.accent}}>hand.</span></>} />
          {[
            [at('access', 'phone'), '360 px, no sideways scroll'],
            [kb, 'Tab · Enter · Ctrl K'],
            [at('access', 'Axe'), 'axe on every page'],
          ].map(([when, text]) => (
            <div key={text as string} style={{position: 'relative', height: 64}}>
              <Stamp at={when as number} rotate={-2} style={{left: 0, top: 0, fontSize: 30}}>{text}</Stamp>
            </div>
          ))}
        </div>
        <Phone clip="phone" from={phone.from} rate={phone.rate} height={760} />
        <div style={{opacity: 0.35 + 0.65 * fade}}>
          <Browser clip="keyboard" from={keys.from} rate={keys.rate} url="lastseat.app" width={900} aspect={1280 / 800} />
          <Who name="Vikram Joshi" role="keyboard only" />
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

// ---- the map the film is built from ------------------------------------------------------------

export const VIEW: Record<string, Scene> = {
  cold: Cold,
  title: Title,
  arena: Arena,
  naive: Naive,
  sql: Statement,
  tests: Tests,
  flow: Flow,
  rollback: Rollback,
  idem: Idempotency,
  rules: Rules,
  security: Security,
  suggest: Suggest,
  access: Access,
  load: Load,
  chaos: Chaos,
  ci: Ci,
  tradeoffs: Tradeoffs,
  close: Close,
};

/** Chapters: the progress bar at the top, and a board turn-over at each start after the first. */
export const CHAPTERS: [string, string[]][] = [
  ['Intro', ['cold', 'title']],
  ['The race', ['arena', 'naive', 'sql', 'tests']],
  ['The product', ['flow', 'rollback', 'idem', 'rules', 'security', 'suggest', 'access']],
  ['The proof', ['load', 'chaos', 'ci']],
  ['Trade-offs', ['tradeoffs', 'close']],
];

/** Sound effects, each at a word of the narration. */
export const SFX: {id: string; t: () => number; name: string; v?: number}[] = [
  {id: 'cold', t: () => at('cold', 'Ten') - 0.1, name: 'flap', v: 0.5},
  {id: 'cold', t: () => at('cold', 'hackathon') - 0.3, name: 'flapshort', v: 0.45},
  {id: 'cold', t: () => at('cold', 'last') - 0.3, name: 'flap', v: 0.5},
  {id: 'cold', t: () => at('cold', 'exactly'), name: 'thunk', v: 0.8},
  {id: 'title', t: () => at('title', 'This') + 0.1, name: 'flap', v: 0.55},
  {id: 'arena', t: () => at('arena', 'winner'), name: 'ding', v: 0.6},
  {id: 'arena', t: () => at('arena', 'refusals'), name: 'pop', v: 0.5},
  {id: 'naive', t: () => at('naive', 'people'), name: 'buzz', v: 0.45},
  {id: 'sql', t: () => at('sql', 'winner'), name: 'thunk', v: 0.7},
  {id: 'tests', t: () => at('tests', 'red'), name: 'buzz', v: 0.5},
  {id: 'rollback', t: () => at('rollback', 'faster'), name: 'buzz', v: 0.35},
  {id: 'idem', t: () => at('idem', 'retry') + 0.8, name: 'ding', v: 0.45},
  {id: 'chaos', t: () => at('chaos', 'Zero'), name: 'ding', v: 0.6},
  {id: 'ci', t: () => at('ci', 'API') - 0.6, name: 'whoosh', v: 0.4},
  {id: 'close', t: () => at('close', 'Fifty') - 0.1, name: 'flap', v: 0.5},
  {id: 'close', t: () => at('close', 'Exactly') - 0.1, name: 'flap', v: 0.5},
];

export {FPS};
