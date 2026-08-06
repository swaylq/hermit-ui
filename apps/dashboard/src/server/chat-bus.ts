// 进程内信号总线：/api/sync/chat-message 落库后 fire 一个 sessionId，
// 同进程内 /api/chat/stream 的 SSE handler 收到信号立即 tick()，
// 替代「服务端每 POLL_MS 轮询 Postgres」的延迟大头。
//
// 为什么不用 Postgres LISTEN/NOTIFY：Prisma 不能 LISTEN，引入 pg 原生
// 连接池 + channel 生命周期管理，而查询成本（收到信号后仍要拉行）完全
// 一样。进程内分发更快更省，不新增任何连接。
//
// 跨 module graph 共享状态（server.ts 走 tsx、Next app 走 bundler，模块级
// 状态互不可见）→ 全部挂 globalThis，与 server/gateway-bridge.ts 的
// __hermitGatewayBridge 同一模式。连接（SSE）关闭时必须 unsubscribe，
// 否则 handler 泄漏、session 键永不回收。

const KEY = '__hermitChatBus';

type Handler = () => void;

interface ChatBusState {
  subs: Map<string, Set<Handler>>;
}

function bus(): ChatBusState {
  const g = globalThis as Record<string, unknown>;
  return (g[KEY] ??= { subs: new Map() }) as ChatBusState;
}

/** 订阅某个 session 的消息落库信号。返回的取消函数必须随连接关闭调用。 */
export function subscribe(sessionId: string, handler: Handler): () => void {
  const { subs } = bus();
  let set = subs.get(sessionId);
  if (!set) {
    set = new Set();
    subs.set(sessionId, set);
  }
  set.add(handler);
  return () => {
    const s = subs.get(sessionId);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) subs.delete(sessionId);
  };
}

/** 广播一次「session 有新写入」。无订阅者时是 O(1) no-op。 */
export function fire(sessionId: string): void {
  const set = bus().subs.get(sessionId);
  if (!set || set.size === 0) return;
  // 拷贝再遍历：handler 在迭代中注销（SSE abort）不破坏 Set 遍历。
  for (const h of [...set]) h();
}
