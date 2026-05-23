---
name: restart
description: Restart this Claude Code session. Use when the user says "restart", "reboot", "重启", or asks to reload the session.
user_invocable: true
---

# Restart Session

Restart the current Claude Code process while keeping the Telegram channel alive.

## Steps

1. Find the current Claude process PID:
```bash
echo $PPID
```

2. Ensure the tmux session exists:
```bash
AGENT_NAME=$(basename "$(pwd)")
tmux has-session -t "claude-$AGENT_NAME" 2>/dev/null || tmux new-session -d -s "claude-$AGENT_NAME" -x 200 -y 50
```

3. Notify the user via Telegram that the session is restarting.

4. Launch the restart script as a fully detached process:
```bash
nohup ./restart.sh <CURRENT_PID> > /dev/null 2>&1 & disown
```

The restart script will:
- Wait 3 seconds (to allow the Telegram notification to send)
- Kill the current Claude process
- Wait for it to exit
- Start a fresh Claude Code process inside the agent's tmux session (provides a real TTY)
- Save the new PID to `agent.pid`
- Verify the Telegram plugin subprocess came up (retry once if not)

**IMPORTANT:** After launching the restart script, do NOT run any more commands. The session will be killed shortly.
