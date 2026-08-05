// What a usage snapshot has to clear before it writes.
//
// The window (`hourBucket >= since`) is the snapshot's own territory: the run owns
// every bucket in it, so the batch that carries the boundary deletes the lot and
// re-inserts. That is only sound while the batch stays inside the window — and it
// doesn't. `ccusage session --since <date>` can return a session whose `lastActivity`
// predates that date, and the collector files a row under the day of its LAST activity,
// so a run reaches back past its own boundary. The delete missed those rows, the
// createMany hit the (machineId, agentName, hourBucket) unique index, and the whole
// transaction rolled back: HTTP 500, nothing written, every 30 minutes. sway003-macmini
// went 5 days with no usage data at all this way (2026-07-31 → 2026-08-05).
//
// So: clear the window, PLUS exactly the pre-window keys this batch is about to write.
// Widening the window to the oldest row instead would be simpler and wrong — it would
// delete every other agent's rows in the reached-back-into period, which no longer come
// back from `ccusage` and which the weekly view still reads.

export type ReplaceRow = { agentName: string; hourBucket: Date };

export type ReplaceWhere = {
  machineId: string;
  OR: Array<{ hourBucket: { gte: Date } } | { agentName: string; hourBucket: Date }>;
};

export function usageReplaceWhere(machineId: string, since: Date, rows: ReplaceRow[]): ReplaceWhere {
  const older = new Map<string, ReplaceRow>();
  for (const r of rows) {
    if (r.hourBucket < since) older.set(`${r.agentName}|${r.hourBucket.toISOString()}`, r);
  }
  return {
    machineId,
    OR: [
      { hourBucket: { gte: since } },
      ...[...older.values()].map((r) => ({ agentName: r.agentName, hourBucket: r.hourBucket })),
    ],
  };
}
