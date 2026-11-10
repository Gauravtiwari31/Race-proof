import React from 'react';
import {AbsoluteFill, Easing, OffthreadVideo, interpolate, random, staticFile, useCurrentFrame} from 'remotion';
import timeline from './timeline.json';
import voice from './voice.json';

/** The app's own palette: warm black, signal amber, paper ink. */
export const C = {
  bg: '#0c0c0b',
  surface: '#151513',
  raised: '#201f1c',
  line: '#4d4941',
  lineSoft: '#2b2925',
  ink: '#f4f0e6',
  inkSoft: '#d2ccbd',
  mute: '#9d9686',
  accent: '#ffb224',
  accentHi: '#ffc65a',
  onAccent: '#1a1200',
  live: '#5ad48a',
  danger: '#ff6b4f',
  blue: '#4c8fe8',
};
export const DISPLAY = "'Barlow Condensed', 'Barlow', sans-serif";
export const SANS = "'Barlow', sans-serif";
export const MONO = "'JetBrains Mono Variable', monospace";
export const FPS = timeline.fps;
export const LEAD = timeline.lead;
export const ease = Easing.bezier(0.2, 0.8, 0.2, 1);
export const spring = Easing.bezier(0.34, 1.56, 0.64, 1);

type Word = {t: number; d: number; w: string};
export const voiceOf = (id: string): {words: Word[]} => (voice as {id: string; words: Word[]}[]).find((v) => v.id === id) ?? {words: []};

const norm = (w: string) => w.replace(/[^a-z0-9']/gi, '').toLowerCase();
/** Seconds into the scene at which a word of its narration is spoken (the nth time it occurs). */
export function at(id: string, word: string, nth = 0): number {
  const hits = voiceOf(id).words.filter((w) => norm(w.w) === norm(word));
  const hit = hits[Math.min(nth, hits.length - 1)];
  if (!hit) throw new Error(`no word "${word}" in scene ${id}`);
  return LEAD + hit.t;
}

/** 0..1 progress of an animation that starts at `start` seconds and lasts `dur`. */
export function useProgress(start: number, dur = 0.5, curve = ease): number {
  const frame = useCurrentFrame();
  return interpolate(frame / FPS, [start, start + dur], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: curve});
}
export const prog = (frame: number, start: number, dur = 0.5, curve = ease) =>
  interpolate(frame / FPS, [start, start + dur], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: curve});

// ---- backdrop ------------------------------------------------------------------------------

/** Warm black with a faint dot grid, like the board's backing plate. */
export const Backdrop: React.FC<{children?: React.ReactNode; glow?: string}> = ({children, glow = 'rgba(255,178,36,0.07)'}) => (
  <AbsoluteFill style={{background: C.bg}}>
    <AbsoluteFill style={{backgroundImage: 'radial-gradient(rgba(244,240,230,0.07) 1.2px, transparent 1.2px)', backgroundSize: '28px 28px'}} />
    <AbsoluteFill style={{background: `radial-gradient(ellipse at 50% 40%, ${glow}, transparent 60%)`}} />
    <AbsoluteFill style={{background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)'}} />
    {children}
  </AbsoluteFill>
);

export const Eyebrow: React.FC<{children: React.ReactNode; color?: string; size?: number; style?: React.CSSProperties}> = ({children, color = C.mute, size = 22, style}) => (
  <div style={{fontFamily: MONO, fontSize: size, letterSpacing: '0.16em', textTransform: 'uppercase', color, ...style}}>{children}</div>
);

// ---- the split-flap board ------------------------------------------------------------------

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Text on split-flap tiles. Each tile spins through random leaves and settles on its letter, left to right,
 * starting at `start` seconds. Spaces are blank tiles, so a line reads as a row of the board.
 */
export const FlapText: React.FC<{
  text: string;
  start: number;
  size?: number;
  color?: string;
  tile?: string;
  stagger?: number;
  spin?: number;
  seed?: string;
  gap?: number;
}> = ({text, start, size = 120, color = C.ink, tile = '#1c1b19', stagger = 0.035, spin = 0.45, seed = 'f', gap}) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const w = size * 0.66;
  const h = size * 1.22;
  return (
    <div style={{display: 'flex', gap: gap ?? size * 0.07}}>
      {text.split('').map((ch, i) => {
        const begin = start + i * stagger;
        const settle = begin + spin;
        const blank = ch === ' ';
        let shown = ch;
        let turning = 0;
        if (t < begin) shown = ' ';
        else if (t < settle && !blank) {
          const step = Math.floor((t - begin) * 24);
          shown = GLYPHS[Math.floor(random(`${seed}-${i}-${step}`) * GLYPHS.length)];
          turning = ((t - begin) * 24) % 1;
        }
        const squeeze = turning ? 1 - Math.sin(turning * Math.PI) * 0.55 : 1;
        if (blank) return <div key={i} style={{width: w * 0.55, height: h}} />;
        return (
          <div
            key={i}
            style={{
              position: 'relative',
              width: w,
              height: h,
              borderRadius: size * 0.06,
              background: `linear-gradient(${tile} 0 50%, #141312 50% 100%)`,
              boxShadow: 'inset 0 -2px 0 rgba(0,0,0,.6), 0 6px 18px rgba(0,0,0,.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            <span style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: size, lineHeight: 1, color, transform: `scaleY(${squeeze})`, opacity: t < begin ? 0 : 1}}>{shown}</span>
            <div style={{position: 'absolute', left: 0, right: 0, top: '50%', height: 2, background: 'rgba(0,0,0,.8)'}} />
          </div>
        );
      })}
    </div>
  );
};

/**
 * A chapter change: the screen turns over like a board, column by column. Between 0.4 and 0.6 of the way
 * through, the tiles are solid, which hides the cut underneath.
 */
export const BoardWipe: React.FC<{p: number; label?: string}> = ({p, label}) => {
  const cols = 16;
  const rows = 9;
  if (p <= 0 || p >= 1) return null;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const delay = (c / cols) * 0.35 + random(`w${r}-${c}`) * 0.05;
      const local = Math.min(1, Math.max(0, (p - delay) / 0.6));
      // 0 → 0.5 the tile flips in, 0.5 → 1 it flips away.
      const scale = local < 0.5 ? Math.sin(local * Math.PI) : Math.sin(local * Math.PI);
      const visible = local > 0 && local < 1;
      tiles.push(
        <div
          key={`${r}-${c}`}
          style={{
            position: 'absolute',
            left: (c * 1920) / cols,
            top: (r * 1080) / rows,
            width: 1920 / cols + 1,
            height: 1080 / rows + 1,
            background: local < 0.5 ? '#1c1b19' : C.accent,
            transform: `scaleY(${visible ? Math.max(0.02, scale) : 0})`,
            borderBottom: '2px solid rgba(0,0,0,.55)',
          }}
        />,
      );
    }
  }
  const labelIn = interpolate(p, [0.3, 0.45, 0.6, 0.72], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      {tiles}
      {label && (
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity: labelIn}}>
          <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 120, color: C.onAccent, textTransform: 'uppercase', letterSpacing: '0.02em'}}>{label}</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

// ---- seats ---------------------------------------------------------------------------------

/** A seat as the app draws it: back, cushion, armrests. */
export const Seat: React.FC<{size?: number; fill?: string; label?: string; empty?: boolean; color?: string; style?: React.CSSProperties}> = ({
  size = 80,
  fill = C.inkSoft,
  label = '',
  empty,
  color = C.bg,
  style,
}) => {
  const w = size * 0.92;
  const h = size;
  const arm = {position: 'absolute' as const, bottom: size * 0.04, width: size * 0.07, height: size * 0.45, borderRadius: size * 0.04, background: empty ? C.line : fill, opacity: empty ? 1 : 0.6};
  return (
    <div style={{position: 'relative', width: w, height: h, ...style}}>
      <div style={{...arm, left: -size * 0.12}} />
      <div style={{...arm, right: -size * 0.12}} />
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: `${size * 0.2}px ${size * 0.2}px ${size * 0.09}px ${size * 0.09}px`,
          background: empty ? 'transparent' : fill,
          border: empty ? `${Math.max(2, size * 0.035)}px dashed ${C.line}` : 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: MONO,
          fontWeight: 600,
          fontSize: size * 0.3,
          color: empty ? C.mute : color,
          boxSizing: 'border-box',
        }}
      >
        {label}
      </div>
    </div>
  );
};

// ---- frames ----------------------------------------------------------------------------------

export type Camera = {t: number; zoom: number; x: number; y: number}[];

/** The camera eases between keyframes: zoom about a point given as a fraction of the frame. */
function camAt(cam: Camera | undefined, t: number) {
  if (!cam || cam.length === 0) return {zoom: 1, x: 0.5, y: 0.5};
  if (t <= cam[0].t) return cam[0];
  for (let i = 0; i < cam.length - 1; i++) {
    const a = cam[i];
    const b = cam[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = ease((t - a.t) / Math.max(0.001, b.t - a.t));
      return {zoom: a.zoom + (b.zoom - a.zoom) * k, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k};
    }
  }
  return cam[cam.length - 1];
}

/** Footage of the real app inside a browser window, with an optional camera move. */
export const Browser: React.FC<{
  clip: string;
  from?: number;
  rate?: number;
  url?: string;
  width: number;
  aspect?: number;
  camera?: Camera;
  title?: string;
  style?: React.CSSProperties;
}> = ({clip, from = 0, rate = 1, url = 'lastseat.app', width, aspect = 1440 / 900, camera, style}) => {
  const frame = useCurrentFrame();
  const cam = camAt(camera, frame / FPS);
  const height = width / aspect;
  const bar = 44;
  return (
    <div style={{width, borderRadius: 16, overflow: 'hidden', background: C.surface, border: `1px solid ${C.lineSoft}`, boxShadow: '0 30px 80px rgba(0,0,0,.6)', ...style}}>
      <div style={{height: bar, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', background: '#121210', borderBottom: `1px solid ${C.lineSoft}`}}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.8}} />)}
        <div style={{marginLeft: 18, flex: 1, height: 28, borderRadius: 8, background: C.raised, display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: MONO, fontSize: 15, color: C.mute}}>{url}</div>
      </div>
      <div style={{position: 'relative', width, height, overflow: 'hidden', background: C.bg}}>
        <div style={{position: 'absolute', inset: 0, transform: `scale(${cam.zoom})`, transformOrigin: `${cam.x * 100}% ${cam.y * 100}%`}}>
          <OffthreadVideo src={staticFile(`footage/${clip}.mp4`)} startFrom={Math.round(from * FPS)} playbackRate={rate} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
        </div>
      </div>
    </div>
  );
};

/** Footage inside a phone. */
export const Phone: React.FC<{clip: string; from?: number; rate?: number; height: number; style?: React.CSSProperties}> = ({clip, from = 0, rate = 1, height, style}) => {
  const width = height * (390 / 844);
  return (
    <div style={{width: width + 28, height: height + 28, borderRadius: 54, background: '#050505', padding: 14, boxShadow: '0 30px 80px rgba(0,0,0,.6), inset 0 0 0 2px #2a2926', ...style}}>
      <div style={{width, height, borderRadius: 42, overflow: 'hidden', position: 'relative', background: C.bg}}>
        <OffthreadVideo src={staticFile(`footage/${clip}.mp4`)} startFrom={Math.round(from * FPS)} playbackRate={rate} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      </div>
    </div>
  );
};

/** A name tag under a browser, so the viewer knows whose screen it is. */
export const Who: React.FC<{name: string; role?: string; color?: string}> = ({name, role, color = C.accent}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: 14, marginTop: 18}}>
    <div style={{width: 44, height: 44, borderRadius: 22, background: color, color: C.onAccent, fontFamily: MONO, fontWeight: 700, fontSize: 17, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
      {name.split(' ').map((p) => p[0]).join('')}
    </div>
    <div style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: 34, color: C.ink, textTransform: 'uppercase'}}>{name}</div>
    {role && <div style={{fontFamily: MONO, fontSize: 18, letterSpacing: '0.14em', color: C.mute, textTransform: 'uppercase'}}>{role}</div>}
  </div>
);

/** A callout that drops in like a stamp, at a time. */
export const Stamp: React.FC<{at: number; children: React.ReactNode; color?: string; style?: React.CSSProperties; rotate?: number}> = ({at: start, children, color = C.accent, style, rotate = -3}) => {
  const p = useProgress(start, 0.35, spring);
  if (p <= 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        transform: `scale(${1.6 - 0.6 * p}) rotate(${rotate}deg)`,
        opacity: Math.min(1, p * 2),
        border: `4px solid ${color}`,
        color,
        background: 'rgba(12,12,11,.88)',
        borderRadius: 14,
        padding: '10px 22px 6px',
        fontFamily: DISPLAY,
        fontWeight: 700,
        fontSize: 44,
        textTransform: 'uppercase',
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        boxShadow: '0 12px 30px rgba(0,0,0,.5)',
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** A panel that rises into place. */
export const Rise: React.FC<{at: number; children: React.ReactNode; style?: React.CSSProperties; dy?: number; dur?: number}> = ({at: start, children, style, dy = 40, dur = 0.6}) => {
  const p = useProgress(start, dur);
  return <div style={{opacity: p, transform: `translateY(${(1 - p) * dy}px)`, ...style}}>{children}</div>;
};

/** A number that counts up to its value, in board digits. */
export const Count: React.FC<{at: number; to: number; dur?: number; decimals?: number; size?: number; color?: string; suffix?: string; group?: boolean}> = ({
  at: start,
  to,
  dur = 1.1,
  decimals = 0,
  size = 160,
  color = C.accent,
  suffix = '',
  group = true,
}) => {
  const p = useProgress(start, dur, Easing.out(Easing.cubic));
  const v = to * p;
  const text = group ? v.toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals}) : v.toFixed(decimals);
  return (
    <span style={{fontFamily: DISPLAY, fontWeight: 700, fontSize: size, color, lineHeight: 0.9, fontVariantNumeric: 'tabular-nums'}}>
      {text}
      {suffix}
    </span>
  );
};

export const Panel: React.FC<{children: React.ReactNode; style?: React.CSSProperties}> = ({children, style}) => (
  <div style={{background: C.surface, border: `1px solid ${C.lineSoft}`, borderRadius: 22, padding: 36, boxShadow: '0 24px 60px rgba(0,0,0,.45)', ...style}}>{children}</div>
);
