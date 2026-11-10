"""Narration: one audio file and word timings per scene, and the film's timeline.

The narrator is Microsoft's Indian English voice, so the cast (Ananya, Rohan, Meera, Arjun) is said the way people in
India say those names. Lines are written for the ear: short sentences, commas where the voice should breathe, numbers
as words, and "Last Seat" as two words so it is never read as "lasts eat".

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
RATE = "+3%"
OUT = HERE / "reel/public/tts"
FPS = 30
LEAD = 0.25  # seconds of picture before the voice starts in every scene
TAIL = 0.35  # default seconds of picture after the voice ends
HOLD = {"cold": 0.4, "title": 1.2, "arena": 0.8, "naive": 0.8, "sql": 0.6, "flow": 0.8, "rollback": 0.8, "close": 3.2}

FACTS = json.loads((HERE / "facts.json").read_text(encoding="utf-8"))

SCENES = {
    "cold": "Ten thousand people. One hackathon. And every team has one last seat. When fifty people click join at the same moment, exactly one of them should get it.",
    "title": "This is Last Seat. Race proof team formation, where the database decides every seat.",
    "arena": "Let me show you. Fifty real requests hit the real database together. One winner. Forty nine clean refusals, each one a four oh nine, team full.",
    "naive": f"Now we switch to the naive code, the one that reads the count, and then writes it. Same fifty clicks, and {FACTS['naiveWinnersWords']} people get one seat. The count no longer matches the members. This is the bug most apps ship.",
    "sql": "Our fix is one statement. Update the team, add one, where the count is still below the maximum. Racers wait on the row lock. When the winner commits, Postgres checks the where clause again, and everyone else updates zero rows. A primary key gives one team per person, and a partial unique index gives exactly one leader.",
    "tests": "And this is proven, not promised. The race test opens fifty connections, holds them at a barrier, and releases them together, twenty times, across two server processes. Then a mutation check swaps in the naive code, and the test goes red. A test that cannot fail, proves nothing.",
    "flow": "Now the product. Ananya creates a team, and becomes the leader. Rohan finds it on the live board, and asks to join. Her screen updates instantly, no refresh. She accepts, and every board in the hackathon shows the seat is gone.",
    "rollback": "Meera tries the last seat with an invite code. Her seat appears straight away, but Arjun was faster. The placeholder rolls back, and she is told exactly why.",
    "idem": "Double clicks and bad networks are also safe. Every write carries an idempotency key, committed in the same transaction as the change. A retry simply gets the original answer back.",
    "rules": "When the leader leaves, the longest standing member takes over. When the last person leaves, the team is deleted in the same transaction. Every change goes into an append only audit log, and the time machine replays it.",
    "security": "Only the leader can accept, decline, or remove, and that is checked after the lock, so a demoted leader cannot slip through. Invite codes carry fifty random bits, are stored only as hashes, and expire. Ten guesses per person, every ten minutes. Every input is validated.",
    "suggest": "Suggestions rank people by the skills your team is missing, and how many hours your time zones overlap. Every score is explained.",
    "access": "And everything works on a phone, and with the keyboard alone. Axe checks every page in the browser tests.",
    "load": f"We seeded ten thousand users and two thousand teams. With a hundred concurrent users, the board's p ninety five is {FACTS['p95Words']} milliseconds, against a budget of two hundred.",
    "chaos": f"Then we killed server replicas every few seconds, in the middle of a write storm. {FACTS['killsWords']} kills. {FACTS['seatsWords']} seats taken. Zero invariant violations.",
    "ci": f"{FACTS['apiTestsWords']} API tests on real Postgres, and {FACTS['e2eTestsWords']} browser tests, run in GitHub Actions on every push.",
    "tradeoffs": "Now the trade offs. A denormalised count for fast reads, kept honest by one transaction and an invariant checker. Server sent events, because updates flow one way. Postgres for rate limits, so there is nothing extra to run. With one more week, a commit ordered event log, waitlists with timed seat holds, and an organiser console.",
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
