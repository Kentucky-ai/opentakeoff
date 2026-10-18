"""HTTP regressions for #538. Uses temporary synthetic data, never a real corpus.

Run: python3 -m unittest discover -s capture -p 'test_*.py' -v
"""
import argparse
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer

from capture_server import Corpus, DEFAULT_ORIGINS, allowed_origin, make_handler


class CaptureOriginsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.corpus = Corpus(str(Path(self.tmp.name) / "corpus"))
        self.start_server()

    def start_server(self, origins=DEFAULT_ORIGINS):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.corpus, origins))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        server, thread = self.server, self.thread

        def stop():
            server.shutdown()
            server.server_close()
            thread.join()

        self.addCleanup(stop)

    def request(self, method, path="/health", origin=None, content_type="application/json", extra=()):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        payload = json.dumps({
            "schema": "opentakeoff.contribution.v1", "sheet_count": 1,
            "conditions": [{"finish": "TEST-1"}],
            "shapes": [{"role": "floor_area", "finish": "TEST-1", "sheet": "sheet_1",
                        "verts_norm": [[.1, .1], [.4, .1], [.4, .3], [.1, .3]],
                        "computed": {"sf": 10}}],
        }).encode() if method == "POST" else b""
        try:
            conn.putrequest(method, path)
            if origin is not None:
                conn.putheader("Origin", origin)
            for name, value in extra:
                conn.putheader(name, value)
            conn.putheader("Content-Type", content_type)
            conn.putheader("Content-Length", str(len(payload)))
            conn.endheaders(payload)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_untrusted_origins_cannot_read_preflight_or_write(self):
        before = list(Path(self.tmp.name).rglob("*"))
        for origin in ("https://example.com", "null", "",
                       "https://opentakeoff.kentucky-ai.com.evil.example",
                       "https://opentakeoff.kentucky-ai.com:444",
                       "http://localhost:5174"):
            for method, path in (("GET", "/health"), ("GET", "/"),
                                 ("OPTIONS", "/contribute"), ("POST", "/contribute")):
                with self.subTest(origin=origin, method=method, path=path):
                    status, headers, body = self.request(method, path, origin)
                    self.assertEqual(status, 403)
                    self.assertNotIn("Access-Control-Allow-Origin", headers)
                    self.assertNotIn("Access-Control-Allow-Private-Network", headers)
                    self.assertNotIn("rows", json.loads(body))
        self.assertEqual(list(Path(self.tmp.name).rglob("*")), before)
        self.assertEqual(self.corpus.summary()["rows"], 0)

    def test_allowed_origins_can_read_preflight_and_contribute(self):
        for origin in sorted(DEFAULT_ORIGINS):
            for method, path, expected in (("GET", "/health", 200),
                                           ("OPTIONS", "/contribute", 204),
                                           ("POST", "/contribute", 200)):
                with self.subTest(origin=origin, method=method):
                    status, headers, _ = self.request(method, path, origin)
                    self.assertEqual(status, expected)
                    self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
                    self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")
                    self.assertEqual(headers["Vary"], "Origin")
        self.assertEqual(self.corpus.summary()["rows"], 1)

    def test_native_client_keeps_working_without_cors_headers(self):
        status, headers, body = self.request("POST", "/contribute")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["rows_added"], 1)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertNotIn("Access-Control-Allow-Private-Network", headers)

    def test_cross_site_request_without_origin_is_rejected(self):
        self.assertEqual(self.request("POST", "/contribute",
                         extra=[("Sec-Fetch-Site", "cross-site")])[0], 403)
        self.assertEqual(self.corpus.summary()["rows"], 0)

    def test_duplicate_origins_are_rejected(self):
        self.assertEqual(self.request("POST", "/contribute", sorted(DEFAULT_ORIGINS)[0],
                         extra=[("Origin", "https://example.com")])[0], 403)
        self.assertEqual(self.corpus.summary()["rows"], 0)

    def test_simple_form_requests_cannot_write(self):
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data"):
            self.assertEqual(self.request("POST", "/contribute", content_type=content_type)[0], 415)
        self.assertEqual(self.corpus.summary()["rows"], 0)

    def test_post_only_writes_at_contribute(self):
        self.assertEqual(self.request("POST", "/health")[0], 404)
        self.assertEqual(self.corpus.summary()["rows"], 0)

    def test_custom_allowlist_replaces_defaults(self):
        self.start_server(["https://takeoff.example.com"])
        self.assertEqual(self.request("POST", "/contribute", "https://takeoff.example.com")[0], 200)
        for origin in DEFAULT_ORIGINS:
            self.assertEqual(self.request("GET", origin=origin)[0], 403)

    def test_configuration_rejects_wildcards_and_non_origins(self):
        for value in ("*", "null", "file://", "https://*.example.com", "https://example.com/",
                      "https://example.com/path", "https://example.com?query", "https://example.com#fragment",
                      "https://user@example.com", "https://example.com:bad", "https://example.com:0",
                      "https://example.com\n"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                allowed_origin(value)


if __name__ == "__main__":
    unittest.main()
