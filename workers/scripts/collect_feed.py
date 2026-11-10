"""公开 RSS/Atom 采集：按固定窗口分页、逐页保存，限流后退出并按冷却时间续取。"""
import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

SOURCES = {
    "reddit": "https://www.reddit.com/r/GlobalOffensive/new/.rss",
    "hltv": "https://www.hltv.org/rss/news",
}
NS = {"a": "http://www.w3.org/2005/Atom"}


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def plain(text):
    parser = Text()
    parser.feed(text)
    return " ".join(parser.parts)


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        parsed = parsedate_to_datetime(value)
    if parsed.tzinfo is None:
        raise ValueError("timestamp_timezone_required")
    return parsed.timestamp()


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def fetch(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": "cs-agent-news/1.0 (public RSS/Atom reader)",
        "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml",
    })
    with urllib.request.urlopen(request, timeout=25) as response:
        raw = response.read(2_000_001)
        content_type = response.headers.get("Content-Type", "")
    if len(raw) > 2_000_000:
        raise ValueError("feed_too_large")
    root, rows = ET.fromstring(raw), []
    if root.tag == "rss":
        for entry in root.findall("./channel/item"):
            rows.append(dict(id=entry.findtext("guid") or entry.findtext("link"),
                             title=entry.findtext("title"), url=entry.findtext("link"),
                             published=entry.findtext("pubDate"),
                             text=plain(entry.findtext("description") or ""),
                             body_status="discovery_only"))
    elif root.tag == "{" + NS["a"] + "}feed":
        for entry in root.findall("a:entry", NS):
            link_url = next((link.get("href") for link in entry.findall("a:link", NS)
                        if link.get("rel", "alternate") == "alternate"), None)
            rows.append(dict(id=entry.findtext("a:id", namespaces=NS),
                             title=entry.findtext("a:title", namespaces=NS), url=link_url,
                             published=entry.findtext("a:published", namespaces=NS),
                             updated=entry.findtext("a:updated", namespaces=NS),
                             text=plain(entry.findtext("a:content", "", NS)),
                             body_status="atom_content_requires_review"))
    else:
        raise ValueError("not_rss_or_atom")
    return dict(status="ok", source=url, fetched_at=iso(time.time()),
                content_type=content_type, items=rows)


def save(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def retry_at(header, now, failures):
    if header:
        value = header.strip()
        if value.isdigit():
            return now + int(value)
        try:
            return max(now, timestamp(value))
        except (ValueError, TypeError, OverflowError):
            pass
    # 没有冷却提示时逐次放慢；不在进程里长时间等待，不更换出口或身份。
    return now + min(3600, 60 * 2 ** min(failures - 1, 6))


def collect(source, start, cutoff, output, max_pages=5, interval=5, *, clock=time.time, sleep=time.sleep, reader=fetch):
    if source not in SOURCES or start >= cutoff or max_pages < 1 or interval < 0:
        raise ValueError("invalid_collection_options")
    path = Path(output)
    if path.exists():
        state = json.loads(path.read_text(encoding="utf-8"))
        if (state.get("schemaVersion"), state.get("source"), state.get("start"), state.get("cutoff")) != (1, source, start, cutoff):
            raise ValueError("checkpoint_window_mismatch")
    else:
        state = dict(schemaVersion=1, source=source, start=start, cutoff=cutoff,
                     status="partial", coverage="unverified", cursor=None,
                     pages=[], items=[], seen=[], failures=0, retryAt=None)
    if state["status"] in ("complete", "blocked"):
        return state
    if state.get("retryAt") and clock() < state["retryAt"]:
        return state
    seen = set(state["seen"])
    for index in range(max_pages):
        if index and interval:
            sleep(interval)
        url = SOURCES[source]
        if source == "reddit":
            params = {"limit": 25}
            if state["cursor"]:
                params["after"] = state["cursor"]
            url += "?" + urllib.parse.urlencode(params)
        try:
            page = reader(url)
            rows = page["items"]
            dates = [timestamp(row["published"]) for row in rows]
            if any(not row["id"] for row in rows) or dates != sorted(dates, reverse=True):
                raise ValueError("feed_order_or_identity_invalid")
            previous = state["pages"][-1]["earliest"] if state["pages"] else None
            if previous is not None and dates and max(dates) > previous:
                raise ValueError("pagination_not_descending")
        except urllib.error.HTTPError as error:
            state["failures"] += 1
            state["lastError"] = dict(code="http_error", status=error.code, url=url)
            retryable = error.code in (429, 500, 502, 503, 504)
            state["status"] = "waiting" if retryable else "blocked"
            state["reason"] = "http_error"
            state["retryAt"] = retry_at(error.headers.get("Retry-After"), clock(), state["failures"]) if retryable else None
            error.close()
            save(path, state)
            return state
        except OSError as error:
            state["failures"] += 1
            state["status"] = "waiting"
            state["lastError"] = dict(code=type(error).__name__, url=url)
            state["reason"] = "network_error"
            state["retryAt"] = retry_at(None, clock(), state["failures"])
            save(path, state)
            return state
        except (ValueError, TypeError, KeyError, ET.ParseError) as error:
            state["status"] = "partial"
            state["lastError"] = dict(code=type(error).__name__, url=url)
            state["reason"] = "invalid_feed"
            state["retryAt"] = None
            save(path, state)
            return state
        new = [row for row in rows if row["id"] not in seen]
        for row, date in zip(rows, dates):
            if start < date <= cutoff and row["id"] not in seen:
                state["items"].append(row)
            seen.add(row["id"])
        state["seen"] = sorted(seen)
        state["pages"].append(dict(url=url, fetchedAt=iso(clock()), count=len(rows),
                                   earliest=min(dates) if dates else None,
                                   latest=max(dates) if dates else None))
        state["failures"], state["retryAt"] = 0, None
        state.pop("lastError", None)
        state["status"], state["reason"] = "partial", "page_budget"
        if dates and min(dates) <= start:
            state.update(status="complete", coverage="source_window", reason="crossed_start")
        elif not rows or not new:
            state["reason"] = "empty_or_repeated_page"
        elif source == "hltv":
            state["reason"] = "feed_window_incomplete"
        elif not rows[-1]["id"].startswith("t3_"):
            state["reason"] = "invalid_reddit_cursor"
        else:
            state["cursor"] = rows[-1]["id"]
            state["retryAt"] = clock() + interval
        save(path, state)
        if state["status"] == "complete" or state["reason"] != "page_budget":
            return state
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", choices=SOURCES)
    parser.add_argument("--start", required=True)
    parser.add_argument("--cutoff", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-pages", type=int, default=5)
    parser.add_argument("--interval", type=float, default=5)
    args = parser.parse_args()
    result = collect(args.source, timestamp(args.start), timestamp(args.cutoff), args.out,
                     args.max_pages, args.interval)
    print(json.dumps({key: result.get(key) for key in ("status", "coverage", "reason", "retryAt", "lastError")}
                     | {"pages": len(result["pages"]), "items": len(result["items"])}, ensure_ascii=False))
    return 0 if result["status"] == "complete" else 75 if result["status"] == "waiting" or result.get("retryAt") else 2


if __name__ == "__main__":
    raise SystemExit(main())
