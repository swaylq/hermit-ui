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
  /**
   * 第二条通道：会话的运行状态（working/idle/alive/activity）变了。
   *
   * 和消息通道分开，因为两者的写入方完全不同——消息来自 /api/sync/chat-message，
   * 状态来自 /api/sync/session-snapshot，后者每 8s 为整台机器的所有会话推一次。
   * 合成一条通道的话，每 8s 会把每个开着的聊天页都叫醒去做一次消息窗口查询，
   * 而那边什么都没变。
   */
  statusSubs: Map<string, Set<Handler>>;
}

function bus(): ChatBusState {
  const g = globalThis as Record<string, unknown>;
  const b = (g[KEY] ??= { subs: new Map(), statusSubs: new Map() }) as ChatBusState;
  // 老进程里建好的 bus 没有这个字段（部署期间新旧代码同存）——补上，
  // 否则第一次 subscribeStatus 会在 undefined 上取 Map。
  b.statusSubs ??= new Map();
  return b;
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

/** 订阅某个 session 的运行状态变化。返回的取消函数必须随连接关闭调用。 */
export function subscribeStatus(sessionId: string, handler: Handler): () => void {
  const { statusSubs } = bus();
  let set = statusSubs.get(sessionId);
  if (!set) {
    set = new Set();
    statusSubs.set(sessionId, set);
  }
  set.add(handler);
  return () => {
    const s = statusSubs.get(sessionId);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) statusSubs.delete(sessionId);
  };
}

/**
 * 有没有人在等这个 session 的状态。
 *
 * 网关每 8s 推一整台机器的快照（几十上百个会话），而真正开着的聊天页通常只有
 * 一两个。写库路由拿这个先筛一遍，没人听的会话连 fire 都不必走。
 */
export function hasStatusSubscriber(sessionId: string): boolean {
  const set = bus().statusSubs.get(sessionId);
  return !!set && set.size > 0;
}

/** 广播一次「session 的运行状态可能变了」。无订阅者时是 O(1) no-op。 */
export function fireStatus(sessionId: string): void {
  const set = bus().statusSubs.get(sessionId);
  if (!set || set.size === 0) return;
  for (const h of [...set]) h();
}
