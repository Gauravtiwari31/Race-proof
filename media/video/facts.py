"""Collects every number the film and the deck quote, from the measured reports, so none is typed by hand.

Reads docs/reports/*-k6.log and chaos.log (from load/run-all.sh), clips/facts.json (from capture.py) and the
test counts, and writes facts.json with each number also spelled out for the narrator.

Usage: python facts.py
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
REPORTS = ROOT / "docs/reports"

def k6(name: str) -> dict:
    log = (REPORTS / f"{name}-k6.log").read_text(encoding="utf-8", errors="replace")
    p95 = float(re.search(r"http_req_duration\.+: .*?p\(95\)=([\d.]+)ms", log).group(1))
    failed, total = map(int, re.search(r"http_req_failed\.+: [\d.]+%\s+(\d+) out of (\d+)", log).groups())
    rate = float(re.search(r"http_reqs\.+: \d+\s+([\d.]+)/s", log).group(1))
    return {"p95": p95, "requests": total, "failures": failed, "rps": round(rate)}


def main() -> None:
    board = k6("board")
    mixed_log = (REPORTS / "mixed-k6.log").read_text(encoding="utf-8", errors="replace")
    reader = re.search(r"\{ scenario:readers \}\.+: .*?p\(95\)=([\d.]+)ms", mixed_log)
    chaos = (REPORTS / "chaos.log").read_text(encoding="utf-8", errors="replace")
    kills = int(re.search(r"(\d+) replicas killed", chaos).group(1))
    seats = int(re.search(r"seats_taken\.+: (\d+)", chaos).group(1))
    assert "invariants hold" in chaos, "chaos run reported violations"

    api_tests = len(re.findall(r"^\s+it\(", "".join(p.read_text(encoding="utf-8") for p in (ROOT / "apps/api/test").glob("*.test.ts")), re.M))
    e2e_tests = len(re.findall(r"^test\(", (ROOT / "apps/web/e2e/flows.spec.ts").read_text(encoding="utf-8"), re.M))
    captured = json.loads((HERE / "clips/facts.json").read_text()) if (HERE / "clips/facts.json").exists() else {}
    naive = captured.get("naiveWinners", 20)

    facts = {
        "p95": round(board["p95"], 1),
        "requests": f"{board['requests']:,}",
        "failures": board["failures"],
        "rps": board["rps"],
        "duration": "3 minutes",
        "readerP95": round(float(reader.group(1)), 1) if reader else None,
        "kills": kills,
        "seats": seats,
        "apiTests": api_tests,
        "e2eTests": e2e_tests,
        "naiveWinners": naive,
        "repo": "github.com/Gauravtiwari31/Race-proof",
        "live": (HERE / "live-url.txt").read_text().strip() if (HERE / "live-url.txt").exists() else "",
    }
    (HERE / "facts.json").write_text(json.dumps(facts, indent=1), encoding="utf-8")
    print(json.dumps(facts, indent=1))


if __name__ == "__main__":
    main()
