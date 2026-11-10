"""Films the real app for the walkthrough: one clip per story beat, with a visible cursor and timed frames.

Needs the Compose stack running (docker compose up -d --build; the app on http://localhost:8080). Every person in the
film signs up fresh, so a run never depends on earlier state. Two people can be filmed at once: each page records its
own frames with wall-clock timestamps, and assemble.py lines them up.

Usage: python capture.py [clip ...]   then   python assemble.py
"""
import base64
import json
import re
import secrets
import shutil
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

HERE = Path(__file__).parent
OUT = HERE / "clips"
BASE = "http://localhost:8080"
RUN = secrets.token_hex(3)
PASSWORD = f"film-{secrets.token_hex(8)}"
expect.set_options(timeout=20000)

CURSOR = """
addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,178,36,.5);border:3px solid #f4f0e6;box-shadow:0 2px 10px rgba(0,0,0,.5);z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:width .1s,height .1s,margin .1s';
  document.documentElement.appendChild(c);
  addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
  addEventListener('mousedown', e => {
    c.style.width = c.style.height = '14px'; c.style.margin = '-7px 0 0 -7px';
    const r = document.createElement('div');
    r.style.cssText = `position:fixed;left:${e.clientX-10}px;top:${e.clientY-10}px;width:20px;height:20px;border-radius:50%;border:4px solid #ffb224;z-index:2147483646;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out`;
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(4)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 500);
  }, true);
  addEventListener('mouseup', () => { c.style.width = c.style.height = '22px'; c.style.margin = '-11px 0 0 -11px'; }, true);
});
"""


class Film:
    """Records one page through the DevTools screencast, so the footage is exactly what the browser painted."""

    def __init__(self, page, width: int, height: int):
        self.page, self.width, self.height = page, width, height
        self.cdp = page.context.new_cdp_session(page)
        self.cdp.on("Page.screencastFrame", self._frame)
        self.dir, self.n, self.rows, self.marks, self.start = None, 0, [], {}, 0.0

    def _frame(self, p):
        if self.dir:
            self.n += 1
            name = f"{self.n:05d}.jpg"
            (self.dir / name).write_bytes(base64.b64decode(p["data"]))
            self.rows.append((name, p["metadata"]["timestamp"]))
        self.cdp.send("Page.screencastFrameAck", {"sessionId": p["sessionId"]})

    def begin(self, name: str):
        self.dir = OUT / name
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(parents=True)
        self.n, self.rows, self.marks = 0, [], {}
        self.start = time.time()
        self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": self.width, "maxHeight": self.height, "everyNthFrame": 1})

    def end(self):
        name = self.dir.name
        self.page.wait_for_timeout(500)
        self.cdp.send("Page.stopScreencast")
        self.page.wait_for_timeout(100)
        (self.dir / "frames.json").write_text(json.dumps({"rows": self.rows, "marks": self.marks, "start": self.start}))
        print(f"{name}: {self.n} frames, {time.time() - self.start:.1f}s, marks {self.marks}", flush=True)
        self.dir = None

    @contextmanager
    def clip(self, name: str):
        self.begin(name)
        try:
            yield
        finally:
            self.end()

    def mark(self, key: str):
        self.marks[key] = round(time.time() - self.start, 2)


def glide(page, locator, click=True, steps=28):
    """Moves the visible cursor to an element in a smooth arc, then clicks it."""
    locator.scroll_into_view_if_needed()
    box = locator.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y, steps=steps)
    page.wait_for_timeout(180)
    if click:
        page.mouse.down()
        page.wait_for_timeout(70)
        page.mouse.up()


def typed(page, text: str, delay=55):
    page.keyboard.type(text, delay=delay)


def person(browser, name: str, skills: list[str], role: str, viewport=(1024, 700), scale=1.5, mobile=False):
    ctx = browser.new_context(
        viewport={"width": viewport[0], "height": viewport[1]},
        device_scale_factor=scale,
        is_mobile=mobile,
        has_touch=mobile,
        reduced_motion="no-preference",
    )
    ctx.add_init_script(CURSOR)
    page = ctx.new_page()
    email = f"{name.split()[0].lower()}.{RUN}@film.lastseat"
    res = page.request.post(
        f"{BASE}/api/auth/signup",
        data={"name": name, "email": email, "password": PASSWORD, "skills": skills, "primaryRole": role, "timezone": "Asia/Kolkata", "availStartMin": 600, "availEndMin": 1320},
        headers={"x-requested-with": "film"},
    )
    assert res.status in (200, 201), res.text()
    return ctx, page


def api(page, method: str, path: str, body=None):
    headers = {"x-requested-with": "film", "idempotency-key": str(uuid.uuid4())}
    res = page.request.fetch(f"{BASE}/api{path}", method=method, data=body, headers=headers)
    assert res.ok, f"{method} {path}: {res.status} {res.text()}"
    return res.json() if res.text() else None


def hackathon_id(page) -> str:
    return api(page, "GET", "/hackathons")["hackathons"][0]["id"]


def film(browser, w, h, page, scale=1.5):
    return Film(page, int(w * scale), int(h * scale))


# ---- the clips --------------------------------------------------------------------------------

def arena(browser, facts):
    ctx, page = person(browser, "Kabir Khanna", ["go", "k8s"], "backend", viewport=(1440, 900), scale=1.34)
    page.goto(f"{BASE}/arena")
    expect(page.get_by_role("button", name="Unleash 50 bots")).to_be_visible()
    page.mouse.move(700, 300)
    cam = film(browser, 1440, 900, page, 1.34)
    with cam.clip("arena"):
        page.wait_for_timeout(900)
        glide(page, page.get_by_role("button", name="Unleash 50 bots"))
        cam.mark("click")
        expect(page.get_by_role("status").filter(has_text="One winner.")).to_be_visible()
        cam.mark("result")
        page.wait_for_timeout(1600)
        page.mouse.wheel(0, 420)
        page.wait_for_timeout(2600)
        cam.mark("stats")
        page.mouse.wheel(0, -420)
        page.wait_for_timeout(700)
    with cam.clip("naive"):
        page.wait_for_timeout(500)
        glide(page, page.get_by_text("Naive read, then write"))
        cam.mark("switch")
        page.wait_for_timeout(500)
        glide(page, page.get_by_role("button", name="Run it again"))
        cam.mark("click")
        status = page.get_by_role("status").filter(has_text="Broken:")
        expect(status).to_be_visible()
        cam.mark("result")
        text = status.inner_text()
        facts["naiveWinners"] = int(re.search(r"Broken: (\d+)", text).group(1))
        page.wait_for_timeout(1500)
        page.mouse.wheel(0, 420)
        page.wait_for_timeout(2800)
        cam.mark("stats")
    ctx.close()


def flow(browser, facts):
    ananya_ctx, ananya = person(browser, "Ananya Iyer", ["react", "figma", "typescript"], "frontend")
    rohan_ctx, rohan = person(browser, "Rohan Mehta", ["postgres", "go", "docker"], "backend")
    team_name = f"Chai and Commits {RUN[:2].upper()}"
    facts["team"] = team_name
    ananya.goto(f"{BASE}/")
    rohan.goto(f"{BASE}/")
    expect(ananya.get_by_role("button", name="Create a team")).to_be_visible()
    expect(rohan.get_by_role("button", name="Create a team")).to_be_visible()
    ananya.mouse.move(500, 200)
    rohan.mouse.move(500, 200)
    a, r = film(browser, 1024, 700, ananya), film(browser, 1024, 700, rohan)
    a.begin("flow_ananya")
    r.begin("flow_rohan")
    try:
        ananya.wait_for_timeout(800)
        glide(ananya, ananya.get_by_role("button", name="Create a team"))
        expect(ananya.get_by_role("dialog")).to_be_visible()
        ananya.wait_for_timeout(300)
        typed(ananya, team_name)
        ananya.keyboard.press("Tab")
        typed(ananya, "postgres, go, ml")
        ananya.wait_for_timeout(300)
        glide(ananya, ananya.get_by_role("button", name="Create team"))
        expect(ananya.get_by_test_id("seat-count")).to_have_text("1/4 seats")
        a.mark("created")
        r.mark("created")
        team_id = ananya.url.rsplit("/", 1)[-1]
        facts["teamId"] = team_id
        ananya.wait_for_timeout(1200)

        # Rohan finds the team on the live board by name, opens it and asks to join.
        search = rohan.get_by_label("Search teams")
        glide(rohan, search)
        typed(rohan, "Chai and", delay=70)
        row = rohan.get_by_role("link", name=re.compile(team_name))
        expect(row).to_be_visible()
        rohan.wait_for_timeout(700)
        glide(rohan, row)
        expect(rohan.get_by_role("button", name="Ask to join")).to_be_visible()
        rohan.wait_for_timeout(600)
        glide(rohan, rohan.get_by_role("button", name="Ask to join"))
        expect(rohan.get_by_role("dialog")).to_be_visible()
        typed(rohan, "I build Postgres backends and love a good race condition.", delay=28)
        glide(rohan, rohan.get_by_role("button", name="Send request"))
        r.mark("asked")
        a.mark("asked")
        expect(ananya.get_by_role("button", name="Accept Rohan Mehta")).to_be_visible()
        a.mark("request-arrives")
        r.mark("request-arrives")

        # Rohan goes back to the board, where the team still shows three open seats.
        rohan.wait_for_timeout(500)
        glide(rohan, rohan.get_by_role("link", name="Board").first)
        search = rohan.get_by_label("Search teams")
        expect(search).to_be_visible()
        search.fill("")
        glide(rohan, search)
        typed(rohan, "Chai and", delay=60)
        expect(rohan.get_by_role("link", name=re.compile(team_name))).to_be_visible()
        rohan.mouse.move(980, 650, steps=12)
        rohan.wait_for_timeout(900)
        glide(ananya, ananya.get_by_role("button", name="Accept Rohan Mehta"))
        a.mark("accepted")
        r.mark("accepted")
        expect(ananya.get_by_test_id("seat-count")).to_have_text("2/4 seats")
        ananya.wait_for_timeout(2600)
    finally:
        a.end()
        r.end()
    facts["_ananya"], facts["_rohan"] = ananya_ctx, rohan_ctx


def rollback(browser, facts):
    ananya = facts["_ananya"].pages[0]
    team_id = facts["teamId"]
    # A third member joins off camera, so exactly one seat is left.
    code = api(ananya, "POST", f"/teams/{team_id}/invites", {"expiresInHours": 48})["code"]
    third_ctx, third = person(browser, "Isha Reddy", ["python", "ml"], "ml")
    api(third, "POST", "/invites/redeem", {"code": code})
    third_ctx.close()
    meera_ctx, meera = person(browser, "Meera Nair", ["react", "css"], "design", viewport=(1440, 900), scale=1.34)
    arjun_ctx, arjun = person(browser, "Arjun Rao", ["ml", "python"], "ml")
    meera.goto(f"{BASE}/teams/{team_id}")
    expect(meera.get_by_test_id("seat-count")).to_have_text("3/4 seats")
    # Meera's view is a moment stale, as a real one is: the seat goes before her page hears about it.
    meera_ctx.route("**/api/events*", lambda route: route.abort())
    meera.reload()
    expect(meera.get_by_test_id("seat-count")).to_have_text("3/4 seats")
    meera.mouse.move(700, 300)
    cam = film(browser, 1440, 900, meera, 1.34)
    with cam.clip("rollback"):
        meera.wait_for_timeout(700)
        glide(meera, meera.get_by_label("Invite code"))
        typed(meera, code, delay=45)
        api(arjun, "POST", "/invites/redeem", {"code": code})
        cam.mark("arjun")
        meera.wait_for_timeout(250)
        glide(meera, meera.get_by_role("button", name="Join with code"))
        cam.mark("click")
        expect(meera.get_by_text("Someone was faster")).to_be_visible()
        cam.mark("refused")
        expect(meera.get_by_test_id("seat-count")).to_have_text("4/4 seats")
        cam.mark("settled")
        meera.wait_for_timeout(2600)
    meera_ctx.close()
    arjun_ctx.close()


def rules(browser, facts):
    """Ananya leaves; Rohan, the longest-standing member, becomes leader live. Then the time machine."""
    ananya, rohan = facts["_ananya"].pages[0], facts["_rohan"].pages[0]
    team_id = facts["teamId"]
    rohan.set_viewport_size({"width": 1440, "height": 900})
    rohan.goto(f"{BASE}/teams/{team_id}")
    expect(rohan.get_by_test_id("seat-count")).to_have_text("4/4 seats")
    rohan.mouse.move(900, 300)
    cam = film(browser, 1440, 900, rohan)
    with cam.clip("rules"):
        rohan.wait_for_timeout(1200)
        api(ananya, "POST", f"/teams/{team_id}/leave")
        cam.mark("left")
        expect(rohan.get_by_role("heading", name="Invite codes")).to_be_visible()
        cam.mark("promoted")
        rohan.wait_for_timeout(1800)
        scrubber = rohan.get_by_label(re.compile(r"Event \d+ of \d+"))
        scrubber.scroll_into_view_if_needed()
        rohan.wait_for_timeout(600)
        cam.mark("machine")
        box = scrubber.bounding_box()
        y = box["y"] + box["height"] / 2
        rohan.mouse.move(box["x"] + box["width"] - 6, y, steps=20)
        rohan.mouse.down()
        rohan.mouse.move(box["x"] + 6, y, steps=60)
        rohan.wait_for_timeout(500)
        rohan.mouse.move(box["x"] + box["width"] - 6, y, steps=90)
        rohan.mouse.up()
        rohan.wait_for_timeout(1500)
    facts["_ananya"].close()


def suggest(browser, facts):
    rohan = facts["_rohan"].pages[0]
    rohan.goto(f"{BASE}/suggestions")
    expect(rohan.get_by_role("heading", name="People for your team")).to_be_visible()
    expect(rohan.get_by_role("listitem").first).to_be_visible()
    rohan.mouse.move(900, 400)
    cam = film(browser, 1440, 900, rohan)
    with cam.clip("suggest"):
        rohan.wait_for_timeout(1500)
        for _ in range(4):
            rohan.mouse.wheel(0, 260)
            rohan.wait_for_timeout(900)
        rohan.wait_for_timeout(800)
    facts["_rohan"].close()


def access(browser, facts):
    ctx, page = person(browser, "Diya Sharma", ["swift", "figma"], "mobile", viewport=(390, 844), scale=2, mobile=True)
    page.goto(f"{BASE}/")
    expect(page.get_by_role("button", name="Create a team")).to_be_visible()
    cam = film(browser, 390, 844, page, 2)
    with cam.clip("phone"):
        page.wait_for_timeout(900)
        for _ in range(3):
            page.mouse.wheel(0, 300)
            page.wait_for_timeout(600)
        page.get_by_role("link", name=re.compile("open|Last seat|Boarding", re.I)).first.tap()
        expect(page.get_by_test_id("seat-count")).to_be_visible()
        page.wait_for_timeout(1500)
        page.mouse.wheel(0, 400)
        page.wait_for_timeout(1000)
        page.get_by_role("link", name="Arena").last.tap()
        expect(page.get_by_role("heading", name="Race Arena")).to_be_visible()
        page.wait_for_timeout(1500)
    ctx.close()

    ctx, page = person(browser, "Vikram Joshi", ["rust", "postgres"], "backend", viewport=(1280, 800), scale=1.5)
    page.goto(f"{BASE}/")
    expect(page.get_by_role("button", name="Create a team")).to_be_visible()
    cam = film(browser, 1280, 800, page)
    with cam.clip("keyboard"):
        page.wait_for_timeout(800)
        for _ in range(40):
            page.keyboard.press("Tab")
            page.wait_for_timeout(170)
            label = page.evaluate("document.activeElement && document.activeElement.innerText")
            if label and "Create a team" in label:
                break
        page.wait_for_timeout(400)
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        typed(page, "Keyboard Crew", delay=60)
        page.keyboard.press("Enter")
        expect(page.get_by_test_id("seat-count")).to_be_visible()
        page.wait_for_timeout(900)
        page.keyboard.press("Control+k")
        page.wait_for_timeout(500)
        typed(page, "arena", delay=90)
        page.wait_for_timeout(300)
        page.keyboard.press("Enter")
        expect(page.get_by_role("heading", name="Race Arena")).to_be_visible()
        page.wait_for_timeout(1200)
    ctx.close()


CLIPS = {"arena": arena, "flow": flow, "rollback": rollback, "rules": rules, "suggest": suggest, "access": access}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    only = sys.argv[1:] or list(CLIPS)
    facts_path = OUT / "facts.json"
    facts = json.loads(facts_path.read_text()) if facts_path.exists() else {}
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", args=["--force-color-profile=srgb"])
        for name in CLIPS:
            # The story is one continuous run: later clips use the people and team the flow created.
            if name in only or (name == "flow" and {"rollback", "rules", "suggest"} & set(only)):
                CLIPS[name](browser, facts)
        browser.close()
    facts_path.write_text(json.dumps({k: v for k, v in facts.items() if not k.startswith("_")}, indent=1))
    print("facts", {k: v for k, v in facts.items() if not k.startswith("_")})


if __name__ == "__main__":
    main()
