// The `event: status` frame on /api/chat/stream — what a session is doing,
// pushed instead of polled.
//
// The chat page already had two ways to know: the gateway's `state` column
// (written on an 8s tick, read on a 5s poll — up to 13s behind) and its own
// guesses on top of it (a send stamp; "the tail bubble grew within 1.8s"). The
// guesses exist only because the column was slow, and each one lapses at a
// moment the column has not caught up to yet — which is how a single send
// rendered working → ready → working.
//
// This carries the column itself, on the gateway's own write. The guesses stay
// as a fallback for backends and machines whose gateway does not push turn
// boundaries yet, but they stop being the thing the status rests on.
//
// Shape note: the fields are exactly the ones `sessionStatusView` reads, and
// they are named identically, so the client merges the frame INTO its session
// row rather than maintaining a second opinion beside it. `snapshotAt` rides
// along for the same reason — it is what the staleness rule measures, and a
// frame without it would be a status nothing could ever expire.

export interface SessionStatusFrame {
  state: string | null;
  alive: boolean;
  activity: unknown;
  snapshotAt: string | null;
  closedAt: string | null;
  restartRequestedAt: string | null;
}

/** The row shape this needs — a subset of ChatSession, as Prisma returns it. */
export interface StatusRow {
  state?: string | null;
  alive?: boolean | null;
  activity?: unknown;
  snapshotAt?: Date | null;
  closedAt?: Date | null;
  restartRequestedAt?: Date | null;
}

export function sessionStatusFrame(row: StatusRow): SessionStatusFrame {
  return {
    state: row.state ?? null,
    alive: row.alive ?? false,
    activity: row.activity ?? null,
    snapshotAt: row.snapshotAt ? row.snapshotAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    restartRequestedAt: row.restartRequestedAt ? row.restartRequestedAt.toISOString() : null,
  };
}

/**
 * What makes a frame worth sending.
 *
 * `snapshotAt` is deliberately NOT in here. The gateway rewrites it every 8s for
 * every session on the machine, so including it would put a frame on the wire
 * every 8s per open tab forever, to say nothing changed. The client keeps
 * getting a fresh `snapshotAt` from its own 5s poll, which is where the
 * staleness clock came from before this existed.
 *
 * The activity LABEL is in here but its elapsed seconds are not, for the same
 * reason at a finer grain: `Bash · 47s` counting up is one frame per second of a
 * long tool call, and the counter the header shows is client-side anyway.
 */
export function statusFrameSignature(f: SessionStatusFrame): string {
  const a = f.activity as {
    kind?: unknown; label?: unknown; backgroundCount?: unknown;
    backgroundTasks?: { id?: unknown }[] | null;
  } | null;
  // WHICH background tasks, not just how many: one finishing as another starts
  // holds the count still while the list underneath it is a different list, and
  // the header would keep naming a task that ended. Ids only — their elapsed
  // seconds are excluded for the same reason a tool's are, one frame a second.
  const bgIds = Array.isArray(a?.backgroundTasks)
    ? a.backgroundTasks.map((t) => String(t?.id ?? '')).join(',')
    : '';
  return [
    f.state ?? '',
    f.alive ? '1' : '0',
    f.closedAt ?? '',
    f.restartRequestedAt ?? '',
    a?.kind ?? '',
    a?.label ?? '',
    a?.backgroundCount ?? '',
    bgIds,
  ].join('|');
}
