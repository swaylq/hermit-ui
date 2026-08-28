export type CodexUsageSlot = {
  usedPercent: number | null;
  resetsAt: Date | string | null;
  limitId: string | null;
  limitName: string | null;
};

export type CodexUsageSlotInput = {
  // Legacy single-window fields.
  usedPercent?: number | null;
  windowMinutes?: number | null;
  resetsAt?: Date | string | null;
  // Current named fields.
  fiveHourPct?: number | null;
  fiveHourResetsAt?: Date | string | null;
  fiveHourLimitId?: string | null;
  fiveHourLimitName?: string | null;
  weekPct?: number | null;
  weekResetsAt?: Date | string | null;
  weekLimitId?: string | null;
  weekLimitName?: string | null;
};

/**
 * Place new and rolling-upgrade Codex readings into fixed dashboard slots.
 * Unknown legacy durations are never guessed; 0% remains a real reading.
 */
export function codexWindowSlots(data: CodexUsageSlotInput): {
  fiveHour: CodexUsageSlot | null;
  weekly: CodexUsageSlot | null;
} {
  const hasFiveHour = data.fiveHourPct != null || data.fiveHourResetsAt != null || data.fiveHourLimitId != null;
  const hasWeekly = data.weekPct != null || data.weekResetsAt != null || data.weekLimitId != null;

  return {
    fiveHour: hasFiveHour
      ? {
          usedPercent: data.fiveHourPct ?? null,
          resetsAt: data.fiveHourResetsAt ?? null,
          limitId: data.fiveHourLimitId ?? null,
          limitName: data.fiveHourLimitName ?? null,
        }
      : data.windowMinutes === 300
        ? {
            usedPercent: data.usedPercent ?? null,
            resetsAt: data.resetsAt ?? null,
            limitId: null,
            limitName: null,
          }
        : null,
    weekly: hasWeekly
      ? {
          usedPercent: data.weekPct ?? null,
          resetsAt: data.weekResetsAt ?? null,
          limitId: data.weekLimitId ?? null,
          limitName: data.weekLimitName ?? null,
        }
      : data.windowMinutes === 10_080
        ? {
            usedPercent: data.usedPercent ?? null,
            resetsAt: data.resetsAt ?? null,
            limitId: null,
            limitName: null,
          }
        : null,
  };
}
