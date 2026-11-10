# Media

The demo film and the pitch deck. Every number in either comes from the measured reports, not typed by hand.

## The film

A [Remotion](https://www.remotion.dev/) composition that cuts real footage of the app together with animated explainers. The footage is filmed from the running product, so nothing in it is mocked.

| Step | Command | Writes |
|:--|:--|:--|
| 1. Start the stack | `docker compose up -d --build` | the app on <http://localhost:8080> |
| 2. Measure | `bash load/run-all.sh` | `docs/reports/` |
| 3. Film the app | `python media/video/capture.py` | `media/video/clips/` |
| 4. Encode the clips | `python media/video/assemble.py` | `reel/public/footage/` |
| 5. Collect the numbers | `python media/video/facts.py` | `media/video/facts.json` |
| 6. Narrate | `python media/video/voice.py` | `reel/public/tts/`, `reel/src/voice.json`, `timeline.json` |
| 7. Score | `python media/video/music.py` | `reel/public/sfx/` (synthesised, nothing licensed) |
| 8. Render | `cd media/video/reel && npm install && npm run render` | `media/out/lastseat-walkthrough.mp4` |

`npm run studio` in `reel/` opens the film in Remotion Studio for frame-by-frame review.

The narration is Microsoft's Indian English neural voice (`en-IN-PrabhatNeural`, through `edge-tts`), and captions are timed from its word boundaries.

## The deck

`media/deck/lastseat-pitch.pptx`, with a PDF export beside it.
