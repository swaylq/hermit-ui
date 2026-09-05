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

It also serves ONE CHAT SESSION, which is what the native timeline needs:
`chat.listMessages`, `chat.listMessagesBefore` and the `/api/chat/stream` SSE
route, all for `s_timeline`. Same trick as above — the row the phone draws is
stamped with the key, the limit and the flags the phone actually asked for, so a
screenshot says which window each transport requested rather than merely that
something arrived.

No request log, unlike tools/api-fixture/server.py — what this drives is a
screen, and the screen is the record.
"""
import itertools
import json
import os
import queue
import re
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

IDENTITY = {"key-one": "m_one", "key-two": "m_two"}

# How many times `chat.listSessions` has been answered, printed into the LAST
# row's title. That number is the only way a screen can show that the list
# refetched on its own: every other row would look identical after a poll, so a
# list that polls and a list that fetched once and froze are the same
# screenshot. `next()` on a count is atomic under the GIL, which this
# ThreadingHTTPServer needs.
SERVED = itertools.count(1)

# The same trick for `chat.getSession`, which the chat header polls on its own
# 5s timer. Stamped into the session TITLE, which is the string the header
# leads with — so one screenshot says the header queried at all, that it sent
# the right key, and (read twice) that its poll is running.
META_SERVED = itertools.count(1)


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
               "hibernatedAt", "restartRequestedAt", "snapshotAt", "createdAt")


def trpc(payload, meta):
    """The batch array a query answers with, carrying a real superjson `meta`.

    `HermitAPI` claims it can ignore `meta` wholesale; a fixture that never
    sends one would never have tested the claim. The timeline is where the
    claim earns its keep — the phone reads `createdAt` as the ISO STRING and
    sorts on it, while superjson is here saying "this is a Date".
    """
    return [{"result": {"data": {"json": payload, "meta": {"values": meta}}}}]


def dates(rows_, prefix):
    """superjson's `values` map for a list of rows, keyed `<prefix><i>.<field>`."""
    meta = {}
    for i, r in enumerate(rows_):
        for f in DATE_FIELDS:
            if r.get(f):
                meta["%s%d.%s" % (prefix, i, f)] = ["Date"]
    return meta


def envelope(payload):
    return trpc(payload, dates(payload, ""))


def unauth(path):
    """tRPC's own refusal shape, which is what a failure line is meant to quote."""
    return [{"error": {"json": {
        "message": "invalid key", "code": -32001,
        "data": {"code": "UNAUTHORIZED", "httpStatus": 401, "path": path}}}}]


# ── the timeline (M4) ────────────────────────────────────────────────────────
#
# One conversation, and everything `ChatTimelineViewController` talks to:
# `chat.listMessages` for the live window, `chat.listMessagesBefore` for history,
# and `/api/chat/stream` for the tail.
#
# **Frozen at import, unlike the session rows above.** Those are rebuilt per
# request because staleness is relative to now; these must not be, because the
# client orders the window and the history pages by `createdAt` into one list. A
# timestamp that slid half a second between the window query and the page query
# would sort a history row after a window row, and the seam would interleave —
# a fixture bug that reads exactly like a bug in the port.
TIMELINE_SESSION = "s_timeline"
TIMELINE_TOTAL = 150
WINDOW = 60          # WebContract.timelineLimit
PAGE = 60            # WebContract.olderPage
LIVE_ID = "m151"     # the row the stream writes, newer than every stored one

# The two rows the stream drops out of the window while the reader is in
# history. Nothing else can show that `adopt` hands them to the history list:
# dropped, they are gone from both lists and no amount of paging brings them
# back, and the screen looks perfectly healthy — the missing middle
# `TimelinePager` exists to prevent.
SHED_IDS = ["m091", "m092"]

T0 = time.time()


def stamp(t):
    """superjson's `toISOString()`: UTC, always three decimals."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % (int(t * 1000) % 1000)


def mid(k):
    """Zero-padded so the id order and the number order are the same order."""
    return "m%03d" % k


# One assistant turn that is a RUN — thinking, a tool call, its result — so the
# fold has a capsule to draw and the screenshot shows one. Block shapes as
# `tools/fixtures/block-cases.json` has them.
RUN_BLOCKS = [
    {"type": "thinking", "thinking": "先看看端口是不是被别的进程占了，再决定要不要改 launch argument。"},
    {"type": "tool_use", "id": "tu_1", "name": "Bash",
     "input": {"command": "lsof -nP -iTCP:49518 -sTCP:LISTEN", "description": "Check the fixture port"}},
    {"type": "tool_result", "tool_use_id": "tu_1", "is_error": False,
     "content": "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\npython3 40311 znm    5u  IPv4  ...      0t0  TCP 127.0.0.1:49518 (LISTEN)"},
]

# A user message long enough to wrap, so the bubble's `max-w-[85%]` is visible
# in the screenshot rather than being a claim about a one-line row. It sits on an
# ODD index, which is what makes it a user row — see `timeline_rows`.
LONG_USER = ("翻页那条路今天只过了编译：药丸、滚动触发、把掉出窗口的行交给历史，"
             "三样都没在真机上走过。这一轮就是要把它们跑一遍。")

TIMES = {k: T0 - (TIMELINE_TOTAL - k) * 30 for k in range(1, TIMELINE_TOTAL + 1)}


def timeline_content(k, name, limit, digest):
    """What message `k` says.

    Three bands, named after where the client has to fetch them from, so a
    screenshot says which list a row came out of:

        1–30    the second page of history
        31–90   the first page of history
        91–150  the live window

    The newest row is the assertion. It carries the key the request arrived
    with and the window it asked for, which is the one thing about this screen
    a Mac cannot check: a shell that reached for `list[0]`, or asked for the
    wrong limit, or forgot `digest`, would draw a full and entirely plausible
    conversation with nothing erroring anywhere.
    """
    if k == TIMELINE_TOTAL:
        return "window · key %s · limit %s · digest %d" % (name, limit, 1 if digest else 0)
    if k == 147:
        return RUN_BLOCKS
    if k == 145:
        return LONG_USER
    if k <= 30:
        return "history page 2 · row %d" % k
    if k <= 90:
        return "history page 1 · row %d" % k
    return "window · row %d" % k


def timeline_rows(name, limit, digest):
    """The whole conversation, oldest first — the server's own order."""
    out = []
    for k in range(1, TIMELINE_TOTAL + 1):
        out.append({
            "id": mid(k),
            "role": "assistant" if (k % 2 == 0 or k == 147) else "user",
            "content": timeline_content(k, name, limit, digest),
            "createdAt": stamp(TIMES[k]),
            "authoredBy": None,
        })
    return out


def live_frame(text):
    """One `event: messages` delta carrying the row the stream owns."""
    row = {"id": LIVE_ID, "role": "assistant", "content": text,
           "createdAt": stamp(T0 + 1), "authoredBy": None}
    return 'event: messages\ndata: {"rows":[%s],"gone":[]}\n\n' % json.dumps(row, ensure_ascii=False)


GONE_FRAME = 'event: messages\ndata: {"rows":[],"gone":%s}\n\n' % json.dumps(SHED_IDS)

# `snapshotAt` deliberately has no milliseconds — a column read straight out of
# Postgres may not carry them, and one missing `.000` must not cost the frame.
TIMELINE_STATUS = ('{"state":"working","alive":true,'
                   '"activity":{"kind":"tool","label":"Bash","elapsedSec":12,"backgroundCount":0},'
                   '"snapshotAt":"%s","closedAt":null,"restartRequestedAt":null}'
                   % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(T0)))

# One queue per live SSE connection, so a route that wants to push a frame can.
# Set on connect and cleared on disconnect: a frame queued for a stream nobody
# is reading is a frame that would be delivered to the NEXT connection, out of
# any order the test could reason about.
EMIT = {}
EMIT_LOCK = threading.Lock()


def emit(sid, frame, after=0.0):
    """Push a frame onto whichever stream is open for `sid`, maybe later."""
    def go():
        with EMIT_LOCK:
            q = EMIT.get(sid)
        if q is not None:
            q.put(frame)
    if after:
        threading.Timer(after, go).start()
    else:
        go()


# ── what the composer writes (M5) ────────────────────────────────────────────
#
# `chat.send` keyed by the caller's `clientId`, which is the whole point of the
# route: a client that retries a send it never saw the answer to passes the same
# key and must get the FIRST call's row back rather than post a second message.
# The dashboard's own router does this against a unique index; here a dict is
# enough to prove the client sends the key and reuses it.
#
# The row that comes back deliberately does NOT say what was typed. `chat.send`
# on the real server writes the text it was given, but the dashboard also has an
# outgoing auto-translate that rewrites it, so the optimistic bubble and its real
# row genuinely differ — and matching them by TEXT is the bug `dropLanded` exists
# to avoid. Echoing something else here is what makes a by-id handoff provable:
# if the shell matched on text, the screen would end up holding both rows.
SENT = {}            # clientId -> the row we answered with
SENT_ORDER = []      # clientIds, in the order they arrived
CANCELS = []         # every chat.cancelTurn we were asked for
SEND_LOCK = threading.Lock()

# ── the waiting queue (M5) ───────────────────────────────────────────────────
#
# What `chat.queue` reports: user messages written and not yet picked up. Every
# `chat.send` lands here and nothing ever drains it — this fixture has no
# gateway, and a queue that emptied itself on a timer would make the strip's
# assertions race a clock.
#
# The seed is a row NOBODY here sent: another client queued it, which is a real
# thing that happens and is also the only way to prove the strip reads
# `chat.queue` rather than the timeline. It is deliberately absent from
# `chat.listMessages` for that reason — on the real server every queued row is
# also a timeline row, so a strip that quietly read the timeline would look
# right there and show nothing at all here.
QUEUE = [{
    "id": "qseed1",
    "content": [{"type": "text", "text": "queued from somewhere else"}],
    "createdAt": stamp(time.time() - 30),
}]
DEQUEUED = []        # every chat.dequeue messageId we were asked for
CLEARS = []          # how many rows each chat.clearQueue took


def sent_row(client_id, text):
    """The row `chat.send` answers with, minted once per clientId."""
    with SEND_LOCK:
        prior = SENT.get(client_id)
        if prior:
            return prior, True
        n = len(SENT_ORDER) + 1
        row = {
            "id": "sent%03d" % n,
            "role": "user",
            "content": [{"type": "text", "text": "server #%d · %s" % (n, text)}],
            "createdAt": stamp(time.time()),
            "authoredBy": None,
        }
        SENT[client_id] = row
        SENT_ORDER.append(client_id)
        return row, False


def sent_frame(row):
    """The `event: messages` delta that lands the row the composer just sent."""
    return 'event: messages\ndata: {"rows":[%s],"gone":[]}\n\n' % json.dumps(row, ensure_ascii=False)


class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1, so `/api/chat/stream` can answer with a chunked body that is
    # written to over minutes. Every other response here sends a content-length
    # (SimpleHTTPRequestHandler does it for files, `reply` does it for JSON), so
    # keep-alive stays honest.
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # one line per asset would bury a traceback

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/trpc/chat.listSessions":
            return self.sessions()
        if route == "/api/trpc/chat.getSession":
            return self.get_session()
        if route == "/api/trpc/chat.listMessages":
            return self.list_messages()
        if route == "/api/trpc/chat.listMessagesBefore":
            return self.list_before()
        if route == "/api/trpc/chat.queue":
            return self.queue()
        if route == "/api/chat/stream":
            return self.stream()
        if route == "/__fixture/sent":
            # What the composer actually posted, for the test to read back. Not a
            # dashboard route — the two leading underscores are there so nobody
            # mistakes it for one.
            return self.reply(200, {"clientIds": SENT_ORDER, "cancels": CANCELS,
                                    "dequeued": DEQUEUED, "clears": CLEARS,
                                    "queue": [r["id"] for r in QUEUE]})
        super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        if route == "/api/trpc/chat.send":
            return self.send_message()
        if route == "/api/trpc/chat.cancelTurn":
            return self.cancel_turn()
        if route == "/api/trpc/chat.dequeue":
            return self.dequeue()
        if route == "/api/trpc/chat.clearQueue":
            return self.clear_queue()
        self.plain(404, "no POST route " + route)

    # ── replies ──────────────────────────────────────────────────────────────

    def reply(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def plain(self, code, text):
        body = text.encode()
        self.send_response(code)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def identity(self):
        """Which keyring entry the caller reached for, or None."""
        return IDENTITY.get(self.headers.get("x-asst-key") or "")

    def trpc_input(self):
        """The `{"0":{"json":…}}` envelope tRPC puts in the query string."""
        raw = (parse_qs(urlparse(self.path).query).get("input") or [""])[0]
        if not raw:
            return {}
        try:
            return (json.loads(raw).get("0") or {}).get("json") or {}
        except (ValueError, AttributeError):
            return {}

    def trpc_body(self):
        """The `{"0":{"json":…}}` envelope tRPC puts in a mutation's BODY."""
        try:
            n = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(n) if n else b""
            return (json.loads(raw).get("0") or {}).get("json") or {}
        except (ValueError, AttributeError, TypeError):
            return {}

    # ── the composer ─────────────────────────────────────────────────────────

    def send_message(self):
        """`chat.send`, keyed by the client's idempotency key.

        The key is REQUIRED here, which the real router does not do (the browser
        composer sends without one). A native client that dropped it would still
        work against the dashboard and lose its only protection against a retried
        send becoming two messages, so this fixture refuses — that is the whole
        thing this route is here to check.
        """
        name = self.identity()
        if not name:
            return self.reply(401, unauth("chat.send"))
        arg = self.trpc_body()
        cid = arg.get("clientId") or ""
        if not re.match(r"^[A-Za-z0-9._:-]{1,128}$", cid):
            return self.reply(200, [{"error": {"json": {
                "message": "clientId missing or outside the charset: %r" % cid,
                "code": -32600,
                "data": {"code": "BAD_REQUEST", "httpStatus": 400, "path": "chat.send"}}}}])
        text = (arg.get("text") or "").strip()
        if not text:
            return self.reply(200, [{"error": {"json": {
                "message": "empty message", "code": -32600,
                "data": {"code": "BAD_REQUEST", "httpStatus": 400, "path": "chat.send"}}}}])
        row, replayed = sent_row(cid, text)
        # The stream carries the row a beat later, exactly as the gateway's does:
        # the mutation answers first, and the delta is what retires the bubble.
        # Not on a replay — the frame for that row has already been sent, and a
        # second one would be a change the client cannot distinguish from a real
        # edit.
        if not replayed:
            emit(TIMELINE_SESSION, sent_frame(row), after=1.0)
            # A sent message is a queued message until a gateway takes it, and
            # there is no gateway here. So it stays, and the shell has to decide
            # for itself which of these rows belongs in the strip — the one that
            # IS the running turn does not (see QueueCore.display's `starters`).
            with SEND_LOCK:
                QUEUE.append({"id": row["id"], "content": row["content"],
                              "createdAt": row["createdAt"]})
        self.reply(200, trpc(row, {"createdAt": ["Date"]}))

    def queue(self):
        name = self.identity()
        if not name:
            return self.reply(401, unauth("chat.queue"))
        with SEND_LOCK:
            rows = list(QUEUE)
        # `envelope` builds superjson's own `values` map for the list, so the
        # strip is answered the way every other list route here is answered.
        self.reply(200, envelope(rows))

    def dequeue(self):
        """Pull one row back out. `removed: false` is a real answer, not an error:
        it means the gateway got there first, and the shell has to put the line
        back rather than leave it hidden."""
        name = self.identity()
        if not name:
            return self.reply(401, unauth("chat.dequeue"))
        mid_ = self.trpc_body().get("messageId") or ""
        DEQUEUED.append(mid_)
        with SEND_LOCK:
            before = len(QUEUE)
            QUEUE[:] = [r for r in QUEUE if r["id"] != mid_]
            removed = len(QUEUE) != before
        self.reply(200, trpc({"removed": removed}, {}))

    def clear_queue(self):
        name = self.identity()
        if not name:
            return self.reply(401, unauth("chat.clearQueue"))
        with SEND_LOCK:
            n = len(QUEUE)
            QUEUE.clear()
        CLEARS.append(n)
        self.reply(200, trpc({"removed": n}, {}))

    def cancel_turn(self):
        name = self.identity()
        if not name:
            return self.reply(401, unauth("chat.cancelTurn"))
        CANCELS.append(self.trpc_body().get("sessionId") or "")
        self.reply(200, trpc({"ok": True}, {}))

    # ── the session list ─────────────────────────────────────────────────────

    def sessions(self):
        name = self.identity()
        code, payload = (200, envelope(rows(name))) if name else (401, unauth("chat.listSessions"))
        self.reply(code, payload)

    # ── the timeline ─────────────────────────────────────────────────────────

    def get_session(self):
        """The one row behind the chat header.

        Chosen to make the header's arithmetic VISIBLE rather than plausible.
        The backend is codex on a 258,400-token window, so 214,000 tokens is
        82.8% and the bar draws amber; with the 1M default the same number is
        21% and green, and nothing on screen would say which denominator was
        used. `activity` is a tool call with an elapsed time, which is the half
        of the state line that `chat.listSessions` deliberately never carries —
        so "Bash · 47s" appearing at all is the proof this route was consulted
        and not the list.
        """
        name = self.identity()
        if not name:
            return self.reply(401, unauth("chat.getSession"))
        arg = self.trpc_input()
        if arg.get("sessionId") != TIMELINE_SESSION:
            return self.reply(200, trpc(None, {}))
        row = {
            "id": TIMELINE_SESSION,
            "agentName": "asst",
            # The mutation counters ride on the title so a `chat.cancelTurn`, a
            # `chat.dequeue` and a `chat.clearQueue` are each visible ON SCREEN
            # one poll later. The alternative was an HTTP call out of the test
            # process to read the fixture's own state, which is a second way for
            # the test to be wrong. `pulls`/`clears` are what tell a strip that
            # emptied itself locally from one that emptied on the server.
            "title": "getSession #%d · key %s · cancels %d · pulls %d · clears %d"
                     % (next(META_SERVED), name, len(CANCELS), len(DEQUEUED), len(CLEARS)),
            "preview": "should never be read — the title is not empty",
            "origin": "web",
            "startedAt": ago(7200), "lastMessageAt": ago(3), "lastReadAt": ago(3),
            "closedAt": None, "hiddenAt": None, "hibernatedAt": None,
            "restartRequestedAt": None,
            "alive": True, "state": "working", "snapshotAt": ago(2),
            "contextTokens": 214000,
            # The RESOLVED backend, the way the server spreads `resolveRuntime`
            # over its answer.
            "runtime": "codex-exec", "runtimeProvider": None,
            "runtimeModel": "gpt-5.6", "runtimeCredentialId": None,
            "runtimeMode": None, "chatOnly": False,
            "activity": {"kind": "tool", "label": "Bash", "elapsedSec": 47},
            "livePreview": None, "rssMb": 512,
            "takeoverBySessionId": None, "takeoverGoal": None, "takeoverTurns": None,
            "takeoverStartedAt": None, "takeoverDraft": None, "takeoverBrainState": None,
        }
        # A single object, so the superjson `values` map is keyed by field name
        # rather than by `<i>.<field>` the way a list of rows is.
        self.reply(200, trpc(row, {f: ["Date"] for f in DATE_FIELDS if row.get(f)}))

    def list_messages(self):
        """The newest `limit` rows — the live window, and nothing else."""
        name = self.identity()
        if not name:
            return self.reply(401, unauth("chat.listMessages"))
        arg = self.trpc_input()
        limit = int(arg.get("limit") or WINDOW)
        if arg.get("sessionId") != TIMELINE_SESSION:
            return self.reply(200, trpc([], {}))
        rows_ = timeline_rows(name, limit, arg.get("digest"))[-limit:]
        self.reply(200, trpc(rows_, dates(rows_, "")))

    def list_before(self):
        """One page of history older than `beforeId`, plus whether more exists."""
        name = self.identity()
        if not name:
            return self.reply(401, unauth("chat.listMessagesBefore"))
        arg = self.trpc_input()
        if arg.get("sessionId") != TIMELINE_SESSION:
            return self.reply(200, trpc({"rows": [], "hasMore": False}, {}))
        limit = int(arg.get("limit") or PAGE)
        all_rows = timeline_rows(name, WINDOW, True)
        anchor = arg.get("beforeId") or ""
        cut = next((i for i, r in enumerate(all_rows) if r["id"] == anchor), 0)
        page = all_rows[max(0, cut - limit):cut]
        # The window drops its two oldest rows a beat after the FIRST page is
        # served. By then the reader is deep in history, which is the state the
        # keep-or-drop rule turns on — and it is the only moment on this screen
        # where losing them would be invisible.
        if page and page[-1]["id"] == mid(90):
            emit(TIMELINE_SESSION, GONE_FRAME, after=1.5)
        self.reply(200, trpc({"rows": page, "hasMore": cut - limit > 0},
                             dates(page, "rows.")))

    # ── the tail ─────────────────────────────────────────────────────────────

    def sse_open(self):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache, no-transform")
        self.send_header("x-accel-buffering", "no")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()

    def put(self, text, pause=0.0):
        """One chunk, flushed — each call is its own TCP write."""
        b = text.encode()
        self.wfile.write(b"%X\r\n" % len(b) + b + b"\r\n")
        self.wfile.flush()
        if pause:
            time.sleep(pause)

    def stream(self):
        """`/api/chat/stream`, speaking the wire shape the real route speaks.

        The two automatic pushes are the point: a timeline that only ever
        changes when you touch it would pass every other assertion in the UI
        test. The first carries what the SHELL asked for on this transport, so
        the screen shows whether the stream and the window query are describing
        the same window; the second rewrites the same id, which is what a turn
        being written looks like and what a diffable data source will not redraw
        on identifier alone.
        """
        q = parse_qs(urlparse(self.path).query)

        def param(k, missing=""):
            return (q.get(k) or [missing])[0]

        name = self.identity()
        if not name:
            return self.plain(401, "unauthorized")
        sid = param("sessionId")
        mine = queue.Queue()
        with EMIT_LOCK:
            EMIT[sid] = mine
        try:
            self.sse_open()
            self.put(": open\n\n")
            if sid == TIMELINE_SESSION:
                self.put("event: status\ndata: %s\n\n" % TIMELINE_STATUS, pause=1.2)
                shape = "key %s · limit %s · digest %s · skipInitial %s · delta %s" % (
                    name, param("limit", "?"), param("digest", "0"),
                    param("skipInitial", "0"), param("delta", "0"))
                # Fifteen seconds between the two, which is a lot of dead
                # time and is the point: the first row is a state the UI test
                # has to CATCH, and a gap of a second or two means it is already
                # gone by the time the assertion runs — the screenshot shows the
                # row and the assertion still fails.
                self.put(live_frame("stream · " + shape), pause=15)
                self.put(live_frame("rewritten in place · " + shape))
            self.pump(mine)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the app went away mid-frame, which every teardown does
        finally:
            with EMIT_LOCK:
                if EMIT.get(sid) is mine:
                    del EMIT[sid]

    def pump(self, q):
        """Stay open, forwarding whatever other routes queue up.

        The pings are not decoration: `HermitStream`'s zombie watchdog gives up
        after `WebContract.streamIdleDeadline` (35s) of silence, so a fixture
        that merely held the socket would be testing the watchdog instead of the
        timeline.
        """
        end = time.time() + 600
        while time.time() < end:
            try:
                self.put(q.get(timeout=5))
            except queue.Empty:
                self.put(": ping\n\n")


ThreadingHTTPServer(
    ("127.0.0.1", int(sys.argv[1])),
    partial(Handler, directory=os.path.dirname(os.path.abspath(__file__))),
).serve_forever()
