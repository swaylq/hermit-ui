// Claude-session uuids a cron fire is currently holding — shared so the CHAT
// runner can exclude them when it decides which transcript is its own.
//
// An agent's crons and its chats spawn with the same cwd, so they write into ONE
// Claude Code project dir. Every "which transcript is mine?" heuristic on either
// side therefore has to know what the other side holds, and the two halves of
// that were added four days apart:
//
//   2026-08-09 — cron learned to exclude chat-owned uuids (adoptDriftTranscript).
//                Two daily-report crons whose pinned transcript was ~1s late had
//                adopted the agent's live CHAT and reported the chat's last
//                assistant message as the cron's result.
//   2026-08-13 — chat learned to exclude cron-owned ones. Until then a chat in
//                the middle of `--resume` sniffed the project dir for "the
//                transcript that just appeared" and could land on a cron that
//                fired during the wait. Observed on macmini002 (agent `ceo`):
//                a 27.2 MB resume took ~10 min, the 2h 看板卡片对话同步 cron
//                fired inside that window, and the chat bound itself to the
//                cron's throwaway transcript. The user's message was answered
//                with the cron's "SKIP 非凌晨"; the real answer went into the
//                now-unowned real transcript and surfaced two hours later as
//                that cron's own result.
//
// Its own module rather than a cron-runner export because chat-runner is what
// needs to read it and cron-runner already imports FROM chat-runner — putting it
// in either one closes an import cycle.
const held = new Set<string>();

// Both forms a fire can end up owning are registered: the uuid it pinned with
// --session-id, and the one it adopted if claude ignored that flag.
export function holdCronUuid(uuid: string): void {
  held.add(uuid);
}

export function releaseCronUuid(uuid: string): void {
  held.delete(uuid);
}

export function cronOwnedUuids(): ReadonlySet<string> {
  return held;
}
