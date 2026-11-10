"""Narration: one audio file and word timings per scene, and the film's timeline.

The narrator is Microsoft's Indian English voice, so the cast (Ananya, Rohan, Meera, Arjun) is said the way people in
India say those names. Lines are written for the ear: short sentences, commas where the voice should breathe,
measured numbers as digits (the voice reads them naturally, and the captions then show them exactly), and
"Last Seat" as two words so it is never read as "lasts eat".

Usage: python voice.py [scene ...]   (needs edge-tts and ffprobe; writes reel/public/tts/*.mp3 and reel/src/voice.json,
reel/src/timeline.json)
"""
import asyncio
import json
import subprocess
import sys
from pathlib import Path

import edge_tts

HERE = Path(__file__).parent
VOICE = "en-IN-PrabhatNeural"
RATE = "+14%"
OUT = HERE / "reel/public/tts"
FPS = 30
LEAD = 0.25  # seconds of picture before the voice starts in every scene
TAIL = 0.35  # default seconds of picture after the voice ends
HOLD = {"cold": 0.4, "title": 1.2, "arena": 0.8, "naive": 0.8, "sql": 0.6, "flow": 0.8, "rollback": 0.8, "close": 3.2}

FACTS = json.loads((HERE / "facts.json").read_text(encoding="utf-8"))

SCENES = {
    "cold": "Ten thousand people. One hackathon. And every team has one last seat. When fifty people click join together, exactly one should get it.",
    "title": "This is Last Seat. Race proof team formation, where the database decides every seat.",
    "arena": "Watch. Fifty real requests hit the database at once. One winner. Forty nine clean refusals, four oh nine, team full.",
    "naive": f"Now the naive code, which reads the count, then writes it. Same fifty clicks, and {FACTS['naiveWinners']} people get one seat. The count no longer matches the members.",
    "sql": "Our fix is one statement. Update the team, add one, where the count is below the maximum. Racers wait on the row lock. When the winner commits, Postgres checks the where clause again, and everyone else updates zero rows. A primary key gives one team per person, a partial unique index, one leader.",
    "tests": "Proven, not promised. The race test holds fifty connections at a barrier, and releases them together, twenty times, across two server processes. Then a mutation check swaps in the naive code, and the test goes red.",
    "flow": "Now the product. Ananya creates a team. Rohan finds it on the live board, and asks to join. Her screen updates instantly. She accepts, and every board shows the seat is gone.",
    "rollback": "Meera tries the last seat. Her seat appears instantly, but Arjun was faster. The placeholder rolls back, and she is told exactly why.",
    "idem": "Retries are safe. Every write carries an idempotency key, committed in the same transaction, so a retry gets the first answer back.",
    "rules": "When the leader leaves, the longest standing member takes over. When the last one leaves, the team is deleted. Every change lands in an append only audit log, with a time machine.",
    "security": "Only the leader can accept or remove, and it is checked after the lock. Invite codes carry fifty random bits, stored as hashes, and they expire. Ten guesses every ten minutes. Every input is validated.",
    "suggest": "Suggestions rank people by missing skills, and time zone overlap, and every score is explained.",
    "access": "It works on a phone, and with the keyboard alone, and Axe checks every page.",
    "load": f"We seeded ten thousand users and two thousand teams. With a hundred concurrent users, the board's p ninety five is {FACTS['p95']} milliseconds, against a budget of two hundred.",
    "chaos": f"Then we killed server replicas every few seconds, during a write storm. {FACTS['kills']} kills. {FACTS['seats']:,} seats taken. Zero invariant violations.",
    "ci": f"{FACTS['apiTests']} API tests on real Postgres, and {FACTS['e2eTests']} browser tests, run in GitHub Actions on every push.",
    "tradeoffs": "The trade offs. A denormalised count for fast reads, guarded by an invariant checker. Server sent events, since updates flow one way. Postgres for rate limits, nothing extra to run. With one more week, a commit ordered event log, waitlists with seat holds, and an organiser console.",
    "close": "Fifty clicks. One seat. Exactly one winner. This is Last Seat.",
}
# Where the music changes: the demo begins, the proof section, the close.
MARKS = {"demo": ("arena", None), "product": ("flow", None), "proof": ("load", None), "close": ("close", None)}


async def speak(name: str, text: str) -> dict:
    words = []
    c = edge_tts.Communicate(text, VOICE, rate=RATE, boundary="WordBoundary")
    with open(OUT / f"{name}.mp3", "wb") as f:
        async for ch in c.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                words.append({"t": round(ch["offset"] / 1e7, 3), "d": round(ch["duration"] / 1e7, 3), "w": ch["text"]})
    dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(OUT / f"{name}.mp3")]))
    return {"id": name, "dur": round(dur, 3), "words": words}


async def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[1:])
    old = {}
    if only and (HERE / "reel/src/voice.json").exists():
        old = {v["id"]: v for v in json.loads((HERE / "reel/src/voice.json").read_text(encoding="utf-8"))}
    data = []
    for name, text in SCENES.items():
        if only and name not in only and name in old:
            data.append(old[name])
            continue
        for attempt in range(4):
            try:
                data.append(await speak(name, text))
                break
            except Exception as exc:  # The service drops connections now and then.
                print("retry", name, attempt, type(exc).__name__, flush=True)
                await asyncio.sleep(2 + attempt * 2)
        else:
            raise SystemExit(f"failed: {name}")
    (HERE / "reel/src/voice.json").write_text(json.dumps(data), encoding="utf-8")

    scenes, start = [], 0
    for item in data:
        # The files end in most of a second of silence, so a scene lasts until the last word, not the file.
        spoken = item["words"][-1]["t"] + item["words"][-1]["d"] + 0.15
        frames = round((LEAD + spoken + HOLD.get(item["id"], TAIL)) * FPS)
        scenes.append({"id": item["id"], "from": start, "frames": frames})
        start += frames
    by_id = {s["id"]: s for s in scenes}
    marks = {}
    for mark, (scene, word) in MARKS.items():
        at = by_id[scene]["from"] / FPS
        if word:
            at += LEAD + next(w["t"] for w in by_id[scene]["words"] if w["w"].strip(".,").lower() == word)
        marks[mark] = round(at, 2)
    timeline = {"fps": FPS, "lead": LEAD, "total": round(start / FPS, 2), "scenes": scenes, "marks": marks}
    (HERE / "reel/src/timeline.json").write_text(json.dumps(timeline, indent=1), encoding="utf-8")
    for item in data:
        print(f"{item['id']:9s} {item['dur']:6.2f}s {len(item['words'])} words")
    print("total film", timeline["total"], "s; speech", round(sum(d["dur"] for d in data), 1), "s; marks", marks)


if __name__ == "__main__":
    asyncio.run(main())
