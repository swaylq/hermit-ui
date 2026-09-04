"""A dashboard that pushes Server-Sent Events without being one.

Speaks the exact wire shape `/api/chat/stream` speaks — chunked `text/event-stream`,
`event: messages` / `event: status`, `: ping` comments — and logs every request it
saw as one JSON line, so the harness can print what actually went out.

The session id selects a SCENE rather than a session; each one exercises a
failure the code cannot be read for:

    s_frames     every frame shape, including a frame split across two packets
    s_silent     opens and then says nothing at all — drives the zombie watchdog
    s_unauth     401, to prove the reconnect loop gives up instead of hammering
    s_notstream  a 200 that is not an event stream (a captive portal)

Threading, not the plain HTTPServer the tRPC fixture uses: an SSE handler holds
its thread for the life of the connection, so a single-threaded server would
refuse every request after the first.

    python3 server.py <port> <request-log-path>
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

LOG = open(sys.argv[2], "w")
LOCK = threading.Lock()
CONNECTS = {}

ROW_A = ('{"id":"m1","role":"assistant","content":"你好 & <b>",'
         '"createdAt":"2026-09-05T02:03:04.567Z","authoredBy":null}')
ROW_B = ('{"id":"m2","role":"user","content":"second",'
         '"createdAt":"2026-09-05T02:03:05.000Z","authoredBy":"brain"}')
ROW_C = ('{"id":"m3","role":"assistant","content":"split across two packets",'
         '"createdAt":"2026-09-05T02:03:06.000Z","authoredBy":null}')
ROW_D = ('{"id":"m4","role":"assistant","content":"after the reconnect",'
         '"createdAt":"2026-09-05T02:03:07.000Z","authoredBy":null}')

# `snapshotAt` deliberately has NO milliseconds: superjson always writes them,
# a column read straight out of Postgres may not, and one missing `.000` must
# not cost the whole frame.
STATUS = ('{"state":"working","alive":true,'
          '"activity":{"kind":"tool","label":"Bash","elapsedSec":47,"backgroundCount":2,'
          '"backgroundTasks":[{"id":"bg1","description":"pnpm build"},{"id":"bg2"}]},'
          '"snapshotAt":"2026-09-05T02:03:00Z","closedAt":null,"restartRequestedAt":null}')
# An opaque JSON column holding something this app does not describe. The
# activity line is allowed to be lost; the state is not.
STATUS_ODD = ('{"state":"idle","alive":false,"activity":"busy",'
              '"snapshotAt":null,"closedAt":null,"restartRequestedAt":null}')


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # the request log below is the record

    # ── framing ──────────────────────────────────────────────────────────────

    def sse_open(self):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache, no-transform")
        self.send_header("x-accel-buffering", "no")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()

    def put(self, s, pause=0.05):
        """One chunk, flushed. Each call is a separate TCP write, which is how
        the split-frame case below actually splits."""
        b = s.encode()
        self.wfile.write(b"%X\r\n" % len(b) + b + b"\r\n")
        self.wfile.flush()
        if pause:
            time.sleep(pause)

    def eof(self):
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def plain(self, code, body, ctype="text/plain; charset=utf-8"):
        b = body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    # ── scenes ───────────────────────────────────────────────────────────────

    def scene_s_frames(self, n):
        if n == 1:
            self.sse_open()
            self.put(": open\n\n")
            self.put("event: status\ndata: %s\n\n" % STATUS)
            self.put("event: status\ndata: %s\n\n" % STATUS_ODD)
            self.put('event: messages\ndata: {"rows":[%s,%s],"gone":["old1","old2"]}\n\n' % (ROW_A, ROW_B))
            # The whole-window shape a server predating `delta=1` sends.
            self.put("event: messages\ndata: [%s]\n\n" % ROW_A)
            # Not JSON at all.
            self.put('event: messages\ndata: {"rows":[\n\n')
            # JSON, right shape, wrong type in a row — what a schema drift looks like.
            self.put('event: messages\ndata: {"rows":[{"id":42}]}\n\n')
            # One frame, two packets, with a gap. Nothing may be delivered until
            # the blank line arrives.
            self.put('event: messages\ndata: {"rows":[', pause=0.15)
            self.put("%s]}\n\n" % ROW_C)
            # A frame type this build of the app has never heard of.
            self.put('event: typing\ndata: {"who":"someone"}\n\n')
            self.put(": ping\n\n")
            self.eof()
        elif n == 2:
            self.sse_open()
            self.put(": open\n\n")
            self.put('event: messages\ndata: {"rows":[%s],"gone":[]}\n\n' % ROW_D)
            self.eof()
        else:
            self.sse_open()
            self.hold()

    def scene_s_silent(self, n):
        self.sse_open()
        self.put(": open\n\n", pause=0)
        self.hold()

    def scene_s_unauth(self, n):
        self.plain(401, "unauthorized")

    def scene_s_notstream(self, n):
        self.plain(200, "<html><body>Sign in to this Wi-Fi network</body></html>", "text/html; charset=utf-8")

    def scene_unknown(self, n):
        self.plain(404, "not found")

    def hold(self):
        """Stay open and say nothing. The client is expected to give up."""
        for _ in range(200):
            time.sleep(0.05)

    # ── routing ──────────────────────────────────────────────────────────────

    def do_GET(self):
        u = urlparse(self.path)
        sid = (parse_qs(u.query).get("sessionId") or [""])[0]
        with LOCK:
            CONNECTS[sid] = CONNECTS.get(sid, 0) + 1
            n = CONNECTS[sid]
            LOG.write(json.dumps({
                "path": self.path,
                "connect": n,
                "key": self.headers.get("x-asst-key"),
                "accept": self.headers.get("accept"),
                "cookie": self.headers.get("cookie"),
            }) + "\n")
            LOG.flush()
        if u.path != "/api/chat/stream":
            return self.plain(404, "no such route")
        scene = getattr(self, "scene_" + sid, None) if sid.isidentifier() else None
        try:
            (scene or self.scene_unknown)(n)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client hung up mid-frame, which several scenes expect


srv = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler)
srv.daemon_threads = True
srv.serve_forever()
