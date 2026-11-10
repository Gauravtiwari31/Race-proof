"""Turns the frames capture.py filmed into 30 fps clips for the film.

Frames arrive whenever the page changes, so each one is held until the next arrives. Writes reel/public/footage/*.mp4
and reel/public/footage/info.json: each clip's duration, its marks in clip time, and the wall-clock time of its first
frame, so two clips filmed at once can be played in sync.

Usage: python assemble.py [clip ...]
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
CLIPS = HERE / "clips"
OUT = HERE / "reel/public/footage"


def assemble(name: str, info: dict) -> None:
    folder = CLIPS / name
    meta = json.loads((folder / "frames.json").read_text())
    rows = meta["rows"]
    lines = []
    for i, (frame, stamp) in enumerate(rows):
        following = rows[i + 1][1] if i + 1 < len(rows) else stamp + 0.5
        lines += [f"file '{frame}'", f"duration {max(following - stamp, 0.001):.4f}"]
    lines.append(f"file '{rows[-1][0]}'")
    (folder / "list.txt").write_text("\n".join(lines))
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str((folder / "list.txt").resolve()),
         "-vf", "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "medium", "-crf", "15",
         "-pix_fmt", "yuv420p", "-g", "15", str((OUT / f"{name}.mp4").resolve())],
        check=True,
    )
    duration = rows[-1][1] - rows[0][1] + 0.5
    # Marks count from when filming started, and the first frame arrives a little after that. In clip time:
    lag = rows[0][1] - meta["start"]
    marks = {key: round(value - lag, 2) for key, value in meta["marks"].items()}
    info[name] = {"duration": round(duration, 2), "frames": len(rows), "marks": marks, "t0": rows[0][1]}
    print(name, info[name])


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    names = sys.argv[1:] or sorted(d.name for d in CLIPS.iterdir() if (d / "frames.json").exists())
    info_path = OUT / "info.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else {}
    for name in names:
        assemble(name, info)
    info_path.write_text(json.dumps(info, indent=1))


if __name__ == "__main__":
    main()
