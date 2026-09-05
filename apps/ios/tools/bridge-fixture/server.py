"""The bridge fixture's server: the static page, plus exactly one tRPC route.

`python3 -m http.server` served this directory until the native session list
needed a `chat.listSessions` to draw. This is that server with one route added,
and the route is the whole point: it answers DIFFERENTLY depending on the
`x-asst-key` it is given, so a screenshot of the list is evidence about WHICH
keyring entry the shell picked.

That is the one thing about the list nothing else can check. `keychain.setActive`
and `KeyStore.active()` exist so the shell sends the same machine's key as the
page two millimetres above it; a shell that ignored the active id and sent
`list[0]` would still draw a full, plausible, completely wrong list, with no
error anywhere. Here the wrong key draws the wrong title.

    python3 server.py <port>

Keys, matching KEYRING in index.html:

    key-one   → the list's first row is titled "active key: m_one"
    key-two   → ... "active key: m_two"
    anything else, or none → 401 in tRPC's own error shape, which is what the
                             list's failure text is supposed to quote

No request log, unlike tools/api-fixture/server.py — what this drives is a
screen, and the screen is the record.
"""
import itertools
import json
import os
import sys
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

IDENTITY = {"key-one": "m_one", "key-two": "m_two"}

# How many times `chat.listSessions` has been answered, printed into the LAST
# row's title. That number is the only way a screen can show that the list
# refetched on its own: every other row would look identical after a poll, so a
# list that polls and a list that fetched once and froze are the same
# screenshot. `next()` on a count is atomic under the GIL, which this
# ThreadingHTTPServer needs.
SERVED = itertools.count(1)


def ago(seconds):
    """superjson's `toISOString()`: UTC, always three decimals."""
    t = time.time() - seconds
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % (int(t * 1000) % 1000)


def rows(name):
    """One row per branch of the status ladder, dated from NOW.

    Relative times are the reason these are built per request rather than
    frozen: `snapshotStaleMs` is 45 seconds, so a fixture with hard-coded
    timestamps would show every live session as `stale` within a minute of
    being written, and the screenshot would look like a bug in the port.

    Field for field as `routers/chat.ts` selects, including the ones
    `SessionListItem` deliberately does not declare.
    """
    def row(**over):
        base = {
            "id": "s", "agentName": "asst", "title": "", "origin": "web",
            "startedAt": ago(3600), "lastMessageAt": None, "lastReadAt": None,
            "closedAt": None, "hiddenAt": None, "groupId": None,
            "restartRequestedAt": None, "alive": True, "state": "idle",
            "contextTokens": 0, "runtime": "claude-sdk", "runtimeProvider": "anthropic",
            "runtimeModel": "opus", "runtimeMode": "default", "chatOnly": False,
            "snapshotAt": ago(2), "rssMb": 640, "hibernatedAt": None,
            "preview": None, "backgroundBusy": False, "backgroundNote": None,
        }
        base.update(over)
        return base

    return [
        # The identity row. Everything else on this screen is scenery; this is
        # the assertion.
        row(id="s_active", title="active key: " + name, state="working",
            lastMessageAt=ago(40), lastReadAt=None),
        # `idle` + background work outstanding: the same amber, dimmed and not
        # pulsing, and the label comes from `backgroundNote` because a sidebar
        # row never carries the `activity` blob.
        row(id="s_parked", title="打包 iOS 构建", agentName="ops",
            backgroundBusy=True, backgroundNote="background · 2 tasks",
            lastMessageAt=ago(300), lastReadAt=ago(300)),
        # The agent finished something you have not read.
        row(id="s_unread", title="Live Activity 的推送令牌", agentName="asst",
            lastMessageAt=ago(1320), lastReadAt=None),
        # Nothing running, nothing wrong — a resting state, so no label at all.
        row(id="s_ready", title="每周清理一次日志", agentName="cron",
            lastMessageAt=ago(4200), lastReadAt=ago(4100)),
        # `state` says working, but the gateway stopped reporting 30 minutes
        # ago, so `state` is a memory rather than evidence.
        row(id="s_stale", title="watchdog 的重试退避", agentName="watch",
            state="working", snapshotAt=ago(1800),
            lastMessageAt=ago(1900), lastReadAt=ago(1900)),
        row(id="s_starting", title="brain 的知识库重建", agentName="brain",
            state="starting", lastMessageAt=ago(20), lastReadAt=ago(20)),
        # An empty title falls through to the preview — JavaScript's falsiness,
        # and the case a brand-new session is always in.
        row(id="s_new", title="", preview="帮我看看这个构建为什么挂了",
            agentName="asst", alive=False, state=None, startedAt=ago(90)),
        # Asleep: the dim green dot, the moon, and the whole row at 60%.
        row(id="s_asleep", title="上周的部署脚本", agentName="ops",
            alive=False, hibernatedAt=ago(7200),
            lastMessageAt=ago(7300), lastReadAt=ago(7300)),
        # Closed outranks a remembered `working`. Long enough to truncate.
        row(id="s_closed", title="把 lib/session-status.ts 移植成 Swift，逐字节对照过一遍",
            agentName="asst", state="working", closedAt=ago(10800),
            lastMessageAt=ago(11000), lastReadAt=ago(11000)),
        # Hidden: the eye, and 50%.
        row(id="s_hidden", title="试验：换一个分词器", agentName="asst",
            hiddenAt=ago(86400), alive=False,
            lastMessageAt=ago(90000), lastReadAt=ago(90000)),
        # The counter. Last rather than first so the identity assertion above it
        # keeps the top of the screenshot it has had since round 13.
        row(id="s_poll", title="poll #%d" % next(SERVED), agentName="fixture",
            alive=False, state=None, lastMessageAt=ago(5), lastReadAt=ago(5)),
    ]


DATE_FIELDS = ("startedAt", "lastMessageAt", "lastReadAt", "closedAt", "hiddenAt",
               "hibernatedAt", "restartRequestedAt", "snapshotAt")


def envelope(payload):
    """The batch array with a real superjson `meta`, not an empty one.

    `HermitAPI` claims it can ignore `meta` wholesale; a fixture that never
    sends one would never have tested the claim.
    """
    meta = {}
    for i, r in enumerate(payload):
        for f in DATE_FIELDS:
            if r.get(f):
                meta["%d.%s" % (i, f)] = ["Date"]
    return [{"result": {"data": {"json": payload, "meta": {"values": meta}}}}]


UNAUTH = [{"error": {"json": {
    "message": "invalid key", "code": -32001,
    "data": {"code": "UNAUTHORIZED", "httpStatus": 401, "path": "chat.listSessions"}}}}]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass  # one line per asset would bury a traceback

    def do_GET(self):
        if self.path.split("?")[0] == "/api/trpc/chat.listSessions":
            return self.sessions()
        super().do_GET()

    def sessions(self):
        name = IDENTITY.get(self.headers.get("x-asst-key") or "")
        code, payload = (200, envelope(rows(name))) if name else (401, UNAUTH)
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(
    ("127.0.0.1", int(sys.argv[1])),
    partial(Handler, directory=os.path.dirname(os.path.abspath(__file__))),
).serve_forever()
