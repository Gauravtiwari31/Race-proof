import React from 'react';
import {AbsoluteFill, Audio, Composition, Sequence, interpolate, registerRoot, staticFile, useCurrentFrame} from 'remotion';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource-variable/jetbrains-mono';
import {BoardWipe, C, DISPLAY, FPS, LEAD, MONO, SANS, at, voiceOf} from './kit';
import {CHAPTERS, SFX, VIEW} from './scenes';
import timeline from './timeline.json';

const SCENES = timeline.scenes;
const TOTAL = SCENES[SCENES.length - 1].from + SCENES[SCENES.length - 1].frames;
const startOf = (id: string) => SCENES.find((s) => s.id === id)!.from;
/** Each new chapter turns the board over; the cut happens under the solid tiles. */
const WIPES = CHAPTERS.slice(1).map(([label, ids]) => ({label, at: startOf(ids[0])}));
const WIPE = 26;

// ---- sound ---------------------------------------------------------------------------------

/** Music sits lower whenever the narrator speaks. */
const speaking: [number, number][] = SCENES.flatMap((s) => {
  const words = voiceOf(s.id).words;
  if (!words.length) return [];
  const last = words[words.length - 1];
  return [[s.from + Math.round((LEAD + words[0].t) * FPS), s.from + Math.round((LEAD + last.t + last.d) * FPS)]] as [number, number][];
});
const BED = 0.2;
const UNDER = 0.075;
const musicVolume = (f: number) => {
  let level = BED;
  for (const [a, b] of speaking) {
    const start = a - 8;
    const end = b + 8;
    const away = f < start ? (start - f) / 12 : f > end ? (f - end) / 12 : 0;
    if (away < 1) level = Math.min(level, UNDER + (BED - UNDER) * away);
  }
  return level * interpolate(f, [0, 20, TOTAL - 60, TOTAL - 4], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
};

// ---- captions ------------------------------------------------------------------------------

/** How some spoken words are written on screen. */
const SHOW: Record<string, string> = {
  thousand: '', Ten: '10,000', Fifty: '50', fifty: '50', nine: '', Forty: '49', four: '', oh: '', '409,': '409', 'proof': 'proof',
  ninety: '', five: '', p: 'p95', twenty: '20', hundred: '', two: '2', ten: '10', zero: '0',
};
const PER_SCENE: Record<string, Record<string, string>> = {
  cold: {Ten: '10,000', thousand: '', fifty: '50'},
  arena: {Fifty: '50', Forty: '49', nine: '', four: '409', oh: '', nine2: ''},
  title: {Last: 'Lastseat', Seat: '', Race: 'Race-proof', proof: ''},
  close: {Fifty: '50', Last: 'Lastseat', Seat: ''},
  load: {p: 'p95', ninety: '', five: ''},
  security: {Ten: '10', ten: '10', fifty: '50'},
};

type Word = {t: number; d: number; w: string};
const chunks = (words: Word[]) => {
  const out: Word[][] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const ends = /[.,?!]$/.test(w.w);
    if (!next || cur.length >= 7 || (ends && cur.length >= 3) || next.t - (w.t + w.d) > 0.3) {
      out.push(cur);
      cur = [];
    }
  });
  return out;
};

const Caption: React.FC<{id: string}> = ({id}) => {
  const frame = useCurrentFrame();
  const t = frame / FPS - LEAD;
  const all = chunks(voiceOf(id).words);
  const i = all.findIndex((c, n) => t >= c[0].t - 0.05 && (n === all.length - 1 || t < all[n + 1][0].t - 0.05));
  if (i < 0) return null;
  const chunk = all[i];
  const last = chunk[chunk.length - 1];
  if (t > last.t + last.d + 0.4) return null;
  const enter = interpolate(t, [chunk[0].t - 0.05, chunk[0].t + 0.12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const map = {...SHOW, ...(PER_SCENE[id] ?? {})};
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 40, pointerEvents: 'none'}}>
      <div style={{display: 'flex', gap: 13, transform: `translateY(${(1 - enter) * 12}px)`, opacity: enter, background: 'rgba(12,12,11,.88)', border: `1px solid ${C.lineSoft}`, borderRadius: 14, padding: '10px 26px 8px', fontFamily: SANS, fontWeight: 600, fontSize: 40, lineHeight: 1.2, boxShadow: '0 10px 30px rgba(0,0,0,.4)'}}>
        {chunk.map((w, n) => {
          const bare = w.w.replace(/[.,?!]$/, '');
          const text = bare in map ? map[bare] + (map[bare] ? w.w.slice(bare.length) : '') : w.w;
          if (!text) return null;
          const on = t >= w.t - 0.03;
          const live = on && t < w.t + w.d + 0.06;
          return <span key={n} style={{color: live ? C.accent : on ? C.ink : 'rgba(244,240,230,.4)'}}>{text}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};

// ---- chrome --------------------------------------------------------------------------------

const Chapters: React.FC = () => {
  const frame = useCurrentFrame();
  const spans = CHAPTERS.map(([label, ids], i) => {
    const start = startOf(ids[0]);
    const end = i + 1 < CHAPTERS.length ? startOf(CHAPTERS[i + 1][1][0]) : TOTAL;
    return {label, start, end, p: interpolate(frame, [start, end], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})};
  });
  const current = spans.findIndex((s) => frame >= s.start && frame < s.end);
  const labelIn = interpolate(frame - (spans[current]?.start ?? 0), [WIPE / 2, WIPE / 2 + 12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  if (current <= 0) return null;
  return (
    <>
      <div style={{position: 'absolute', top: 22, left: 40, right: 40, display: 'flex', gap: 8}}>
        {spans.slice(1).map((s) => (
          <div key={s.label} style={{flex: s.end - s.start, height: 5, borderRadius: 3, background: 'rgba(244,240,230,.12)', overflow: 'hidden'}}>
            <div style={{height: '100%', width: `${s.p * 100}%`, background: C.accent}} />
          </div>
        ))}
      </div>
      <div style={{position: 'absolute', top: 42, left: 40, opacity: labelIn, display: 'flex', gap: 14, alignItems: 'baseline'}}>
        <span style={{fontFamily: MONO, fontSize: 20, letterSpacing: '0.16em', color: C.accent}}>{String(current).padStart(2, '0')}</span>
        <span style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 26, letterSpacing: '0.08em', color: C.inkSoft, textTransform: 'uppercase'}}>{spans[current].label}</span>
      </div>
    </>
  );
};

const Wipes: React.FC = () => {
  const frame = useCurrentFrame();
  const w = WIPES.find((x) => frame >= x.at - WIPE / 2 && frame < x.at + WIPE / 2);
  if (!w) return null;
  const p = (frame - (w.at - WIPE / 2)) / WIPE;
  return <BoardWipe p={p} />;
};

const Reel: React.FC = () => (
  <AbsoluteFill style={{background: C.bg, fontFamily: SANS}}>
    <Audio src={staticFile('sfx/music.wav')} volume={musicVolume} />
    {SCENES.map((s) => {
      const View = VIEW[s.id];
      return (
        <Sequence key={s.id} from={s.from} durationInFrames={s.frames} name={s.id}>
          <View dur={s.frames / FPS} />
          <Caption id={s.id} />
          <Sequence from={Math.round(LEAD * FPS)} layout="none">
            <Audio src={staticFile(`tts/${s.id}.mp3`)} volume={1.3} />
          </Sequence>
        </Sequence>
      );
    })}
    {WIPES.map((w) => (
      <Sequence key={w.at} from={w.at - WIPE / 2} durationInFrames={30} layout="none">
        <Audio src={staticFile('sfx/flap.wav')} volume={0.5} />
      </Sequence>
    ))}
    {SFX.map((fx, i) => {
      const s = SCENES.find((row) => row.id === fx.id)!;
      return (
        <Sequence key={i} from={s.from + Math.round(fx.t() * FPS)} durationInFrames={60} layout="none">
          <Audio src={staticFile(`sfx/${fx.name}.wav`)} volume={fx.v ?? 1} />
        </Sequence>
      );
    })}
    <Wipes />
    <Chapters />
  </AbsoluteFill>
);

export {at};
const Root: React.FC = () => <Composition id="Reel" component={Reel} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />;
registerRoot(Root);
