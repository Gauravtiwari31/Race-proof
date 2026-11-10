"""Original music and sound effects for the film, synthesised here so there is nothing to license.

The bed is a quiet, steady pulse in A minor (Am, F, C, G) that follows the film: sparse for the cold open, a beat when
the demo starts, a little more drive for the proof section, and a resolve at the end. The effects are the sounds of
a departures board: split-flap clatter, a single flap tick, a row-lock thunk, a soft ding, and an error buzz.

Usage: python music.py   (reads reel/src/timeline.json from voice.py, writes reel/public/sfx/*.wav)
"""
import json
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, lfilter

SR = 44100
HERE = Path(__file__).parent
OUT = HERE / "reel/public/sfx"
rng = np.random.default_rng(7)
BPM = 104
BEAT = 60 / BPM


def t(sec: float) -> np.ndarray:
    return np.arange(int(SR * sec)) / SR


def save(name: str, x: np.ndarray) -> None:
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    peak = np.abs(x).max()
    if peak > 0.98:
        x = x / peak * 0.98
    OUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype(np.int16).tobytes())


def lowpass(x: np.ndarray, cutoff: float, order: int = 2) -> np.ndarray:
    b, a = butter(order, cutoff / (SR / 2), "low")
    return lfilter(b, a, x)


def highpass(x: np.ndarray, cutoff: float, order: int = 2) -> np.ndarray:
    b, a = butter(order, cutoff / (SR / 2), "high")
    return lfilter(b, a, x)


def env(n: int, attack: float, release: float) -> np.ndarray:
    a = min(n, int(attack * SR))
    r = min(n - a, int(release * SR))
    e = np.ones(n)
    if a:
        e[:a] = np.linspace(0, 1, a)
    if r:
        e[n - r:] = np.linspace(1, 0, r) ** 2
    return e


def midi(m: float) -> float:
    return 440 * 2 ** ((m - 69) / 12)


# ---- instruments ---------------------------------------------------------------------------

def pad(notes: list[int], sec: float) -> np.ndarray:
    """Warm chord: detuned saws through a soft low-pass, slow in and out."""
    tt = t(sec)
    x = np.zeros_like(tt)
    for m in notes:
        for detune in (-0.07, 0.0, 0.06):
            f = midi(m + detune)
            x += 2 * ((tt * f) % 1) - 1
    x = lowpass(x / (len(notes) * 3), 900, 2)
    return x * env(len(tt), 0.6, 0.9) * 0.5


def pluck(m: int, sec: float = 0.5) -> np.ndarray:
    tt = t(sec)
    f = midi(m)
    x = np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(4 * np.pi * f * tt) + 0.12 * np.sign(np.sin(2 * np.pi * f * tt))
    return lowpass(x, 3200) * np.exp(-tt * 9) * 0.5


def bass(m: int, sec: float) -> np.ndarray:
    tt = t(sec)
    f = midi(m)
    x = np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(4 * np.pi * f * tt)
    return x * env(len(tt), 0.005, 0.08) * np.exp(-tt * 3) * 0.6


def kick() -> np.ndarray:
    tt = t(0.35)
    f = 48 + 90 * np.exp(-tt * 35)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 9) * 0.9


def hat() -> np.ndarray:
    tt = t(0.06)
    return highpass(rng.standard_normal(len(tt)), 7000) * np.exp(-tt * 70) * 0.18


def place(track: np.ndarray, x: np.ndarray, at: float, gain: float = 1.0) -> None:
    i = int(at * SR)
    if i >= len(track):
        return
    n = min(len(x), len(track) - i)
    track[i:i + n] += x[:n] * gain


# ---- the bed ---------------------------------------------------------------------------------

CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55, 60], [55, 59, 62]]  # Am, F, C, G
ROOTS = [33, 29, 36, 31]
ARP = [[69, 72, 76, 72], [65, 69, 72, 69], [64, 67, 72, 67], [67, 71, 74, 71]]


def bed(total: float, marks: dict) -> np.ndarray:
    n = int((total + 2) * SR)
    left, right = np.zeros(n), np.zeros(n)
    bar = BEAT * 4
    bars = int(total / bar) + 2
    demo, proof, close = marks["demo"], marks["proof"], marks["close"]
    for b in range(bars):
        start = b * bar
        if start > total:
            break
        c = b % 4
        p = pad(CHORDS[c], bar + 0.9)
        place(left, p, start, 0.55)
        place(right, p, start, 0.55)
        if start >= demo - 0.01 and start < close:
            for beat in range(4):
                at = start + beat * BEAT
                place(left, bass(ROOTS[c] + 12, BEAT * 0.9), at, 0.55)
                place(right, bass(ROOTS[c] + 12, BEAT * 0.9), at, 0.55)
                if beat in (0, 2):
                    place(left, kick(), at, 0.32)
                    place(right, kick(), at, 0.32)
                for half in (0, 0.5):
                    h = hat()
                    place(left, h, at + half * BEAT, 0.9 if half else 0.5)
                    place(right, h, at + half * BEAT + 0.004, 0.9 if half else 0.5)
            # The arpeggio joins for the product demo and the proof, panned slightly.
            if start >= marks["product"]:
                for i, m in enumerate(ARP[c] * 2):
                    at = start + i * BEAT / 2
                    g = 0.16 if start < proof else 0.2
                    place(left, pluck(m), at, g * 1.1)
                    place(right, pluck(m), at + 0.012, g * 0.9)
    # Resolve: a long A minor chord with an added ninth under the final line.
    end = pad([45, 57, 60, 64, 71], 5.5)
    place(left, end, close, 0.75)
    place(right, end, close, 0.75)
    fade = np.ones(n)
    k = int(2.5 * SR)
    stop = min(n, int((total + 0.5) * SR))
    fade[stop - k:stop] = np.linspace(1, 0, k)
    fade[stop:] = 0
    return np.stack([left * fade, right * fade], axis=1)


# ---- effects ---------------------------------------------------------------------------------

def tick() -> np.ndarray:
    """One split-flap leaf landing: a sharp, papery click with a little body."""
    tt = t(0.05)
    noise = highpass(rng.standard_normal(len(tt)), 1800) * np.exp(-tt * 160)
    body = np.sin(2 * np.pi * 1300 * tt) * np.exp(-tt * 120) * 0.4
    return (noise + body) * 0.6


def flap(leaves: int = 14, sec: float = 0.55) -> np.ndarray:
    """A row of the board turning over: leaves fall fast, then slow down and settle."""
    x = np.zeros(int(SR * (sec + 0.1)))
    times = sec * (np.linspace(0, 1, leaves) ** 1.6)
    for i, at in enumerate(times):
        place(x, tick() * (0.6 + 0.4 * rng.random()), at + rng.random() * 0.006, 1.0 if i < leaves - 1 else 1.4)
    return x


def thunk() -> np.ndarray:
    """A row lock closing: a low knock and a latch click."""
    tt = t(0.4)
    f = 70 + 120 * np.exp(-tt * 40)
    low = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 14)
    x = low * 0.9
    place(x, tick(), 0.012, 0.8)
    return x


def ding() -> np.ndarray:
    tt = t(1.6)
    x = sum(a * np.sin(2 * np.pi * midi(88) * r * tt) * np.exp(-tt * d) for a, r, d in [(1, 1, 3), (0.5, 2.76, 5), (0.25, 5.4, 8)])
    return x * 0.35


def buzz() -> np.ndarray:
    tt = t(0.45)
    x = np.sign(np.sin(2 * np.pi * 110 * tt)) + 0.5 * np.sign(np.sin(2 * np.pi * 116 * tt))
    return lowpass(x, 1400) * env(len(tt), 0.005, 0.12) * 0.25


def whoosh() -> np.ndarray:
    tt = t(0.7)
    noise = rng.standard_normal(len(tt))
    sweep = np.concatenate([lowpass(noise[i:i + 2205], 300 + 5000 * (i / len(tt)) ** 1.5) for i in range(0, len(tt), 2205)])[: len(tt)]
    return sweep * np.sin(np.pi * tt / tt[-1]) ** 2 * 0.5


def pop() -> np.ndarray:
    tt = t(0.12)
    f = 900 * np.exp(-tt * 18) + 300
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 30) * 0.4


def main() -> None:
    timeline = json.loads((HERE / "reel/src/timeline.json").read_text(encoding="utf-8"))
    save("music", bed(timeline["total"], timeline["marks"]))
    save("flap", flap())
    save("flapshort", flap(7, 0.25))
    save("tick", tick())
    save("thunk", thunk())
    save("ding", ding())
    save("buzz", buzz())
    save("whoosh", whoosh())
    save("pop", pop())
    print("wrote", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()
