# Paging history in summary mode

Measurements first, because they overturn the obvious diagnosis.

## What summary mode costs today

One 3,968-message session (`产品站动效复刻与优化`), cold local cache, the same
upward fling repeated, 1440×900:

| | full | summary |
|---|---|---|
| open | 60 rows, 5.65 screens | **13 rows, 3.55 screens** |
| 4 gestures | 7 requests, 420 raw rows, 986 KB | 8 requests, 480 raw rows, 1129 KB |
| rows on screen after | 479 | **120** |
| reading gained (5 gestures) | 41k chars | 37k chars |

The obvious guess — "summary mode starves you, each pull yields almost nothing" —
is wrong. Pulls are scroll-driven, so summary mode simply pulls more pages to
cover the same gesture and the reading you get per gesture is comparable
(+5.4–6.9k px vs +3.6–7.7k px).

What is actually wrong is the exchange rate. Summary mode downloads **480
messages / 1.1 MB to display 120 rows**: three quarters of the payload is
tool output that is filtered out after it arrives. Tool results are ~2/3 of all
content bytes (621 MB of 904 MB on this machine), so the waste is not marginal —
it is most of the transfer, and it lands hardest on the phone.

Second, the open state is thin — 3.55 screens vs 5.65 — because "one page" is
counted in raw messages, and in this session raw messages collapse ~5.9× into
prose rows.

## The asset nobody is using

The local cache built for full-history search already stores **every message's
prose for the whole workspace** — measured live: 18,522 rows across 68 sessions,
covering 94,772 server messages, ~11 MB. For the session above: all **671** of
its prose rows are already on disk, while its `full` (timeline) store holds only
the LRU tail.

And the projection matches. `server/chat-text.ts:extractSearchText` keeps
non-empty `text` blocks; `SUMMARY_KEEP` in the timeline keeps non-empty `text`
blocks. **Summary mode renders exactly what the cache already holds.**

So summary-mode paging can be served from IndexedDB: zero requests, zero bytes,
no round trip, and pages counted in rows the reader will actually see.

## Where the two projections disagree

Diffed over the six most recent non-empty sessions (whole sessions, row-id sets):

| session | msgs | summary rows | cached prose | only cached | only summary |
|---|---|---|---|---|---|
| 优化对话框滚动流畅性 | 628 | 47 | 46 | 0 | 1 |
| UI 去 AI 化及循环修复 | 2696 | 490 | 490 | 0 | 0 |
| 产品站动效复刻与优化 | 3968 | 674 | 671 | 0 | 3 |
| 聊天记录本地缓存与标题自动更新 | 1298 | 132 | 129 | 0 | 3 |
| 拉取 hermit-ui 更新 | 1368 | 408 | 408 | 0 | 0 |
| hermit ui 更新助手 | 720 | 218 | 213 | 1 | 6 |

Two small, understood gaps:

- **only cached** — the harness terminator (`No response requested.`) is prose,
  so the cache keeps it while `toSummaryView` drops it. Filter it on the way out.
- **only summary** — `toSummaryView` keeps every `system` row unconditionally,
  including ones whose content is not a text block (restart notices, interaction
  cards). Those have no prose, so the cache does not hold them. 0–6 rows per
  session, but they are exactly the rows a reader would notice missing.

Neither is a blocker; both have to be handled deliberately.

## Options

**A — serve summary paging from the local cache.** Zero network, instant, pages
measured in visible rows, and the thin open state disappears (a cheap local read
can cover several screens). Costs: switching back to full mode needs the real
rows for whatever was paged in from cache, so the toggle stops being purely
client-side; and sessions not yet synced need a fallback.

**B — scale the page size.** Keep server paging; in summary mode ask for more raw
messages per page so one gesture is one comfortable screenful and the session
opens thicker. Smallest change, keeps the toggle instant — and keeps downloading
the tool output it will throw away.

**C — a slimmer server page.** A summary-aware `listMessagesBefore` that filters
tool rows server-side and returns prose only. Cuts the bytes without depending on
local sync state, but adds an endpoint plus a cache-seam to keep coherent, and
the toggle back to full still needs a refetch.

**A + B** — cache-first, with B's larger server page as the fallback for sessions
that are not fully synced.

Recommended: **A**, with the system-row gap closed rather than accepted.
