# Caddy WS Timeout Hardening (Manual Step)

Caddy v2 doesn't time out hijacked WebSocket connections by default, so the
browser terminal works today. But a future Caddy release could change the
default and silently break long-lived `/api/term/<sid>` connections. This patch
makes the policy explicit so an upgrade can't surprise us.

The `dash.swaylab.ai` block in `/etc/caddy/Caddyfile` (around line 358) should
look like this after the change:

```caddyfile
https://dash.swaylab.ai:8443 {
  tls /etc/letsencrypt/live/dash.swaylab.ai/fullchain.pem /etc/letsencrypt/live/dash.swaylab.ai/privkey.pem

  reverse_proxy localhost:4101 {
    header_up Host {host}
    # WebSocket-friendly: never time out the upstream conn. The browser
    # terminal (/api/term/<sid>) and gateway control channel (/api/gateway/ws)
    # are both long-lived. Heartbeats every 15-20s keep traffic flowing both
    # ways; explicit 0 disables any default timeout regardless of Caddy
    # version. flush_interval -1 also bypasses response buffering, important
    # for SSE on /api/chat/stream.
    flush_interval -1
    transport http {
      read_timeout 0
      write_timeout 0
      dial_timeout 10s
    }
  }
}
```

## Apply on VPS

```bash
ssh ubuntu@45.89.234.110

# Back up Caddyfile
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%s)

# Edit /etc/caddy/Caddyfile, find the `https://dash.swaylab.ai:8443 {` block
# and replace the `reverse_proxy localhost:4101 { … }` block with the snippet
# above.
sudo nano /etc/caddy/Caddyfile

# Validate before reload
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile

# Graceful reload (no downtime, keeps active conns)
sudo systemctl reload caddy
```

## Verify

```bash
# WS handshake still ok
ssh ubuntu@45.89.234.110 'curl -sI -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" http://localhost:4101/api/gateway/ws?key=invalid | head -3'
# Expect: HTTP/1.1 401 Unauthorized
```

Browser smoke: open `https://dash.swaylab.ai/chat/terminal?session=<sid>` and
confirm the terminal renders + stays connected for >5 minutes idle.
