"""最小行为回归：429 断点恢复、RSS 窗口与拒绝访问，不执行真实联网。"""
import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collect_feed", Path(__file__).parents[1] / "scripts" / "collect_feed.py")
feed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed)


def page(*entries):
    return {"items": [dict(id="t3_" + str(date), published=feed.iso(date), title="测试", text="证据") for date in entries]}


class CollectorTests(unittest.TestCase):
    def test_rate_limit_saves_page_and_resumes_after_server_cooldown(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "run.json"
            now, requested = [1000], []

            def reader(url):
                requested.append(url)
                if len(requested) == 1:
                    return page(190, 170)
                raise urllib.error.HTTPError(url, 429, "limited", {"Retry-After": "120"}, io.BytesIO())

            result = feed.collect("reddit", 100, 200, output, interval=0, reader=reader, clock=lambda: now[0])
            self.assertEqual(result["status"], "waiting")
            self.assertEqual(result["reason"], "http_error")
            self.assertEqual(result["retryAt"], 1120)
            self.assertEqual(result["cursor"], "t3_170")
            self.assertEqual(len(json.loads(output.read_text(encoding="utf-8"))["items"]), 2)
            feed.collect("reddit", 100, 200, output, interval=0, reader=reader, clock=lambda: now[0])
            self.assertEqual(len(requested), 2)
            now[0] = 1120

            def resume(url):
                requested.append(url)
                self.assertIn("after=t3_170", url)
                return page(170, 120, 90)

            result = feed.collect("reddit", 100, 200, output, reader=resume, clock=lambda: now[0])
            self.assertEqual(result["status"], "complete")
            self.assertEqual([row["id"] for row in result["items"]], ["t3_190", "t3_170", "t3_120"])
            self.assertEqual(len(requested), 3)

    def test_hltv_partial_feed_and_403_do_not_claim_coverage_or_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            result = feed.collect("hltv", 100, 200, Path(directory) / "rss.json", reader=lambda _: page(190, 170))
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["reason"], "feed_window_incomplete")
            output = Path(directory) / "blocked.json"
            with patch.object(feed.urllib.request, "urlopen", side_effect=urllib.error.HTTPError("https://www.hltv.org/rss/news", 403, "forbidden", {}, io.BytesIO())) as request:
                result = feed.collect("hltv", 100, 200, output)
                feed.collect("hltv", 100, 200, output)
                self.assertEqual(request.call_count, 1)
                self.assertEqual(result["status"], "blocked")

    def test_xml_parsing_and_http_date_cooldown(self):
        xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_1</id><title>公告</title><published>2026-11-10T00:00:00Z</published><content>&lt;p&gt;正文&lt;/p&gt;</content><link href="https://example.com/news"/></entry></feed>'
        response = io.BytesIO(xml.encode("utf-8"))
        response.headers = {"Content-Type": "application/atom+xml"}
        with patch.object(feed.urllib.request, "urlopen", return_value=response):
            self.assertEqual(feed.fetch("https://example.com/feed")["items"][0]["text"], "正文")
        now = feed.timestamp("2026-11-10T00:00:00Z")
        self.assertEqual(feed.retry_at("Tue, 10 Nov 2026 00:02:00 GMT", now, 1), now + 120)
        self.assertEqual(feed.retry_at(None, now, 2), now + 120)


if __name__ == "__main__":
    unittest.main()
