# The composer used to interrupt the agent when you tapped it

Reported as: *"偶尔点到聊天框会触发 interrupt"* — every so often, touching the chat box
kills the turn the agent is in the middle of.

It was not a race, a stray event or a phantom request. The stop control was **inside the
chat box, in the send button's slot**, and looked exactly like the send button.

## The only path an interrupt can take

```
browser  chat.cancelTurn                      (dashboard, tRPC mutation)
  → DB   ChatSession.cancelRequestedAt = now  (server/routers/chat.ts)
  → gateway chatCancelTick                    (gateway/src/chat-runner.ts, 2s poll)
  → sendInterrupt                             (packages/tmux-driver — tmux send-keys Escape)
  → claude writes "[Request interrupted by user]" into its JSONL
  → the transcript tail syncs that row back into the conversation
```

`cancelRequestedAt` has exactly one writer (`chat.cancelTurn`), and before this change
that mutation had exactly two callers in the whole client: the composer's stop button and
a `window` keydown listener on Escape. Nothing else in the product can interrupt a turn,
which is what made the report diagnosable at all.

## Evidence

Every `[chat-cancel] sent Escape` line in the gateway's retained logs, matched against the
agents' JSONL transcripts (gateway logs are local time, transcripts UTC):

| interrupt | session | what the human did next |
|---|---|---|
| 08-07 18:12:09 | mengshu | 2m17s later: "你自己去测试一下" |
| 08-11 16:22:35 | research | 2m51s later: "毛发要更精细，现在太颗粒性了" |
| 08-12 14:55:51 | research | 39s later: "继续" |
| 08-12 15:23:13 **and 15:23:17** | asst | "继续" |
| 08-12 15:25:57 | asst (another session) | — |

Three things stand out. The interrupts land mid-stream, while the assistant is producing
text. A short follow-up — usually literally "继续" — arrives less than three minutes later,
i.e. nobody meant to stop anything. And two of them are **four seconds apart on the same
session**: the shape of a mis-tap followed by a second tap in the same place, not of a
decision.

## Why the box did it

`composer.tsx` swapped the send button for a stop button whenever a turn was in flight:

- **Same slot.** Both were `h-9 w-9 rounded-full bg-foreground text-background` — same
  size, same colour, same position at the right edge of the pill. The glyph (▪ vs ↑) was
  the only difference. On a 390px phone that circle is the rightmost ~36px of the box:
  about a tenth of its width, and the single most-tapped target in the app.
- **Touch has no alternative.** The composer deliberately lets the return key insert a
  newline on touch devices, so on a phone that circle is the *only* way to send. Muscle
  memory sends every thumb there.
- **It moved under your finger.** With a draft typed, stop and send both rendered — two
  identical dark circles, 6px apart, stop on the left. Sending cleared the draft, which
  unmounted the clear-draft × and the send button, and stop slid right into the exact
  pixels send had just occupied. A double tap, an impatient second tap, or iOS's delayed
  click then hit stop.
- **No confirmation, no undo.** One tap ended a turn that might have been running for ten
  minutes, and the only trace was claude's own `[Request interrupted by user]` row.

## What it is now

- **Stop is not in the composer.** It is a labelled pill (`StopPill` in the chat page)
  floating above the box: says "Stop", rose-coloured, centred — nowhere near the send
  column. The composer's circle now means exactly one thing, always.
- **A short arming delay.** A turn can begin under a finger already travelling toward
  that spot (tapping "↓ latest", dismissing the keyboard), so clicks landing within
  400ms of the pill appearing are ignored. You can only stop a turn by aiming at a pill
  that was already there.
- **Escape stopped being a side effect.** The `window` handler took *every* Escape on the
  page, so dismissing an IME composition, closing the image lightbox, closing in-chat
  find or closing the mobile sidebar all killed the running turn as a bonus. It now
  stands down when the event was already handled, when focus is in a text field, or when
  a layer that owns Escape is open — those mark themselves with `data-esc-layer`
  (`overlay.tsx`, `image-lightbox`, `context-menu`, `workspace-switcher`, `chat-find`, and
  the sidebar while its mobile drawer is open). The composer additionally stops
  propagation itself: Escape in the box clears the draft and never touches the turn.

## Still open

The terminal view (`/chat/terminal`) pins a quick-key bar to the bottom edge whose first
two keys are `Esc` and `^C`, both of which interrupt claude and neither of which goes
through `cancelTurn` — so a mis-tap there is invisible in the logs above. Same hazard
class, untouched by this change.
