"""A fake /api/asr, spoken over a real WebSocket.

    python3 tools/asr-fixture/server.py <port> <log.jsonl>

Hand-rolled rather than `websockets`: this repo ships with no Python
dependencies, and the half of RFC 6455 a client exercises is a handshake and two
frame types. Same bargain as the multipart parser in bridge-fixture/server.py.

It exists because the Mac this is developed on has NO AUDIO INPUT DEVICE, so a
dictation run cannot be driven on the simulator here at all — and the socket is
the half of the feature that a machine without a microphone can still be honest
about. What it proves: the URL, the `hermit-key.<token>` SUBPROTOCOL (the one
channel the server actually authenticates on), that audio queued before the
socket opened is not dropped, and that the three layers of text arrive in the
order the reducer expects, including a correction that comes back out of order.
"""
import base64, hashlib, json, os, socket, struct, sys, threading, time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PORT = int(sys.argv[1])
LOG = sys.argv[2]

def log(**kw):
    with open(LOG, "a") as f:
        f.write(json.dumps(kw, ensure_ascii=False) + "\n")

def read_frame(conn):
    """One client frame. Returns (opcode, payload) or None when it hangs up."""
    head = recv_exact(conn, 2)
    if not head:
        return None
    opcode = head[0] & 0x0F
    masked = head[1] & 0x80
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", recv_exact(conn, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", recv_exact(conn, 8))[0]
    mask = recv_exact(conn, 4) if masked else b"\0\0\0\0"
    data = recv_exact(conn, length) or b""
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data

def recv_exact(conn, n):
    out = b""
    while len(out) < n:
        chunk = conn.recv(n - len(out))
        if not chunk:
            return None
        out += chunk
    return out

def send_text(conn, obj):
    payload = json.dumps(obj, ensure_ascii=False).encode()
    header = b"\x81"
    if len(payload) < 126:
        header += bytes([len(payload)])
    else:
        header += b"\x7e" + struct.pack(">H", len(payload))
    conn.sendall(header + payload)

def handshake(conn):
    """Read the request line and headers; answer 101 iff this is an upgrade."""
    raw = b""
    while b"\r\n\r\n" not in raw:
        chunk = conn.recv(4096)
        if not chunk:
            return None
        raw += chunk
    lines = raw.decode("latin-1").split("\r\n")
    path = lines[0].split(" ")[1] if lines else ""
    headers = {}
    for line in lines[1:]:
        if ": " in line:
            k, v = line.split(": ", 1)
            headers[k.lower()] = v
    key = headers.get("sec-websocket-key")
    proto = headers.get("sec-websocket-protocol", "")
    log(event="open", path=path, protocol=proto,
        # The header the browser CANNOT set, and therefore the one the server
        # must not be reading. Recorded so the test can assert it is absent.
        asstKey=headers.get("x-asst-key"))
    if not key:
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        return None
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    reply = ("HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\nConnection: Upgrade\r\n"
             f"Sec-WebSocket-Accept: {accept}\r\n")
    # Echo the subprotocol back, which is what the real route does — a client
    # that offered one and got nothing back is entitled to close.
    if proto:
        reply += f"Sec-WebSocket-Protocol: {proto.split(',')[0].strip()}\r\n"
    conn.sendall((reply + "\r\n").encode())
    return path

def serve(conn):
    if not handshake(conn):
        conn.close()
        return
    send_text(conn, {"type": "ready"})
    audio = 0
    said = False
    while True:
        frame = read_frame(conn)
        if frame is None:
            break
        opcode, data = frame
        if opcode == 0x8:                       # close
            break
        if opcode == 0x2:                       # binary: audio
            audio += len(data)
            # Say something once enough audio has arrived to prove the pre-open
            # buffer was flushed rather than dropped.
            if not said and audio >= 6400:
                said = True
                send_text(conn, {"type": "partial", "text": "把隧道"})
                # The ids are 4 and 9, NOT 0 and 1. A client that addresses
                # corrections by array position passes with contiguous ids from
                # zero and only ever fails in production, where the server
                # numbers segments across the whole task.
                send_text(conn, {"type": "final", "segId": 4, "text": "把隧道重启一下"})
                send_text(conn, {"type": "final", "segId": 9, "text": "然后看日志"})
                # OUT OF ORDER on purpose: the second sentence's correction first.
                send_text(conn, {"type": "polished", "segId": 9, "text": "然后看看日志。"})
                send_text(conn, {"type": "polished", "segId": 4, "text": "把隧道重启一下。"})
            continue
        if opcode == 0x1:                       # text: control
            try:
                msg = json.loads(data.decode())
            except Exception:
                continue
            log(event="control", frame=msg, audioBytes=audio)
            if msg.get("type") == "stop":
                send_text(conn, {"type": "done"})
                time.sleep(0.1)
                break
    log(event="close", audioBytes=audio)
    conn.close()

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT))
srv.listen(4)
open(LOG, "w").close()
while True:
    c, _ = srv.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
