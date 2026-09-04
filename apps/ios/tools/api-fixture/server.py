"""A dashboard that answers tRPC without being one.

Speaks exactly the wire format HermitAPI.swift speaks — the batch array, the
`{json, meta}` envelope, the tRPC error shape — and logs every request it saw as
one JSON line, so the harness can show what actually went out rather than what
the Swift meant to send.

Routes are named after what they are FOR, not after a real procedure, except the
four M2 段二 needs. The `boom.*` ones exist because the failure paths are the
half you cannot check by reading the code.

    python3 server.py <port> <request-log-path>
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = open(sys.argv[2], "w")

# `meta` is filled in on the two Date fields exactly as superjson would, so the
# "ignore meta wholesale" claim is tested against a payload that really has one.
OK_ME = [{"result": {"data": {
    "json": {"id": "m_1", "name": "mac001", "alias": None, "hostname": "znmac",
             "keyPrefix": "abc", "createdAt": "2026-09-05T00:46:12.345Z",
             "lastSeen": "2026-09-05T01:00:00Z",
             "fiveHourLimitUsd": 12.5, "weeklyLimitUsd": None},
    "meta": {"values": {"createdAt": ["Date"], "lastSeen": ["Date"]}}}}}]
OK_LIST = [{"result": {"data": {
    "json": {"sessions": [{"id": "s1", "title": "你好 & 再见"}]}, "meta": {}}}}]
OK_MUTATION = [{"result": {"data": {"json": {"ok": True}, "meta": {}}}}]

# A real `chat.listSessions` row, field for field as routers/chat.ts returns it
# — including the eleven fields SessionListItem deliberately does NOT declare,
# because "the shell ignores what it does not draw" is the claim being checked.
# Dates are superjson's `toISOString()` with the matching `meta`, and the second
# row is the awkward one: never spoken in, so `lastMessageAt` is null and the
# recency key has to fall back to `startedAt`.
RECENTS = [{"result": {"data": {
    "json": [
        {"id": "s_live", "agentName": "asst", "title": "iOS 原生化 — 会话列表",
         "origin": "web", "startedAt": "2026-09-05T02:10:00.000Z",
         "lastMessageAt": "2026-09-05T06:41:00.000Z",
         "lastReadAt": "2026-09-05T06:40:00.000Z",
         "closedAt": None, "hiddenAt": None, "groupId": None,
         "restartRequestedAt": None, "alive": True, "state": "working",
         "contextTokens": 412_000, "runtime": "claude-sdk", "runtimeProvider": "anthropic",
         "runtimeModel": "opus", "runtimeMode": "default", "chatOnly": False,
         "snapshotAt": "2026-09-05T06:41:30.000Z", "rssMb": 812, "hibernatedAt": None,
         "preview": "接着做 M3", "backgroundBusy": False, "backgroundNote": None},
        {"id": "s_new", "agentName": "brain", "title": "",
         "origin": "web", "startedAt": "2026-09-05T06:39:00.000Z",
         "lastMessageAt": None, "lastReadAt": None,
         "closedAt": None, "hiddenAt": None, "groupId": "g1",
         "restartRequestedAt": None, "alive": False, "state": None,
         "contextTokens": 0, "runtime": "claude-sdk", "runtimeProvider": "anthropic",
         "runtimeModel": "sonnet", "runtimeMode": "default", "chatOnly": True,
         "snapshotAt": None, "rssMb": None, "hibernatedAt": "2026-09-05T06:39:30.000Z",
         "preview": None, "backgroundBusy": True, "backgroundNote": "background · 12m"},
    ],
    "meta": {"values": {
        "0.startedAt": ["Date"], "0.lastMessageAt": ["Date"], "0.lastReadAt": ["Date"],
        "0.snapshotAt": ["Date"], "1.startedAt": ["Date"], "1.hibernatedAt": ["Date"]}}}}}]

ERR_401 = [{"error": {"json": {
    "message": "invalid key", "code": -32001,
    "data": {"code": "UNAUTHORIZED", "httpStatus": 401, "path": "machines.me"}}}}]
BAD_DATE = [{"result": {"data": {
    "json": {"id": "x", "name": "n", "alias": None, "hostname": None,
             "keyPrefix": "p", "createdAt": "not-a-date", "lastSeen": None,
             "fiveHourLimitUsd": None, "weeklyLimitUsd": None}, "meta": {}}}}]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # the request log below is the record; stderr noise hides it

    def reply(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def route(self, body):
        LOG.write(json.dumps({
            "method": self.command, "path": self.path,
            "key": self.headers.get("x-asst-key"),
            "accept": self.headers.get("accept"),
            "ctype": self.headers.get("content-type"),
            "cookie": self.headers.get("cookie"),
            "body": body,
        }) + "\n")
        LOG.flush()
        proc = self.path.split("?")[0]
        if proc == "/api/trpc/machines.me":
            return self.reply(200, OK_ME)
        if proc == "/api/trpc/chat.listSessions":
            return self.reply(200, OK_LIST)
        if proc == "/api/trpc/chat.recents":
            return self.reply(200, RECENTS)
        if proc in ("/api/trpc/push.register", "/api/trpc/chat.markRead"):
            return self.reply(200, OK_MUTATION)
        # A tRPC refusal: the status AND a real sentence in the body.
        if proc == "/api/trpc/boom.unauth":
            return self.reply(401, ERR_401)
        # A proxy, not the dashboard — must not be read as a tRPC error.
        if proc == "/api/trpc/boom.proxy":
            return self.reply(502, b"<html><head><title>502 Bad Gateway</title></head></html>", "text/html")
        # 200, JSON, and not the batch shape at all.
        if proc == "/api/trpc/boom.garbage":
            return self.reply(200, {"not": "a batch"})
        # A Date field that is not a date.
        if proc == "/api/trpc/boom.baddate":
            return self.reply(200, BAD_DATE)
        return self.reply(404, {"unknown": proc})

    def do_GET(self):
        self.route(None)

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        self.route(self.rfile.read(n).decode() if n else "")


HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
