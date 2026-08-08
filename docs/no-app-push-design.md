# 不开发 app 的 iOS 推送 — 设计

**Goal:** 让 iPhone 收到 hermit 的锁屏推送，**不开发 app，不买 Apple 开发者账号**。

**Non-goals:** 替换 `apps/ios` 原生壳（它仍然是麦克风免弹框的唯一解，见 `docs/ios-shell-design.md`）；Android；自建 APNs。

---

## 出发点：管线早就建好了，缺的只是最后一跳

`src/server/push/` 从一开始就分层得很干净，而且**只有最后一跳跟 APNs 绑定**：

| 文件 | 职责 | 跟传输通道有关吗 |
|---|---|---|
| `types.ts` | `PushEvent{kind,title,body,path,collapseKey,sessionId}` | ❌ |
| `events.ts` | 6 个事件构造器（chat / blocked / cron / stall / host） | ❌ |
| `suppress.ts` | 静默时段 23–08、「你正在看这个会话」60s 抑制 | ❌ |
| `index.ts` | `enqueuePush()` fire-and-forget、chat 20s 去抖、死设备回收 | 仅设备扇出那一段 |
| `apns.ts` | ES256 JWT + HTTP/2 | ✅ 全部 |

所以本方案**不是重写推送**，而是把 `index.ts` 里那次 `sendApns()` 换成一次 `transport.send()`。事件构造、去抖、静默时段、折叠语义、深链全部原样复用。

卡点也只有一个：原生壳要 `aps-environment` entitlement，**必须付费 Apple Developer（$99/年）**。免费账号签的包 7 天过期。

## 选型

两条真正「不用开发 app」的路，一起上：

| | Web Push | Bark |
|---|---|---|
| 手机上要装什么 | 已有的 PWA 加到主屏 | App Store 装 Bark（免费） |
| Apple 账号 | 不需要 | 不需要 |
| 服务端凭据 | VAPID 密钥对（自己生成） | **无** |
| 锁屏显示 | Hermit 图标 | Bark 图标 |
| 点击跳转 | 直接回到 PWA 对应会话 | Safari 打开 |
| 主要风险 | 长期不打开会**悄悄掉订阅** | 多一个 app |

**为什么两个都要：它们的失效方式不相关。** iOS 会回收长期未打开的主屏 Web App 订阅，而且不通知任何人——Web Push 单独用有一个静默盲区。Bark 是个常驻 app，不受这条规则影响。反过来 Bark 体验差一档。两个同时注册没有额外成本：`collapseKey` 早就在了，同一条通知在两条线上带同一个折叠 key，不会变成两次打扰。

考虑过但没选：**Pushover**（$5 买断，可靠，但既然 Bark 免费且能自建就没必要）、**ntfy**（自建后 iOS 仍要回中继 ntfy.sh 发 APNs，自建的意义打折）、**Telegram/飞书 bot**（混在聊天流里，不是锁屏级信号）。

---

## 架构

```
                          src/server/push/
  PushEvent ──▶ index.ts ──▶ suppress.ts ──▶ transport.ts ──┬──▶ webpush.ts ──▶ Apple/Mozilla/Google 推送服务 ──▶ 主屏 PWA
              (去抖/扇出)     (静默/在看)      (按 platform 分派) ├──▶ bark.ts    ──▶ api.day.app 或自建 ──▶ Bark app
                                                              └──▶ apns.ts    ──▶ APNs ──▶ apps/ios 原生壳
```

一台机器的设备可以是三种的任意组合，`index.ts` 对三者完全一致。

### `PushDevice` 表

表结构几乎没动：`platform` 本来就在，`token` 本来就是「这台设备的身份」，Web Push 的 endpoint URL 和 Bark 的 device key 都能直接塞进去，`(token, machineId)` 唯一约束照旧生效。只加两个可空列，老的 `ios` 行零改动、零回填：

- `subscription Json?` — web 专用，`{endpoint, keys:{p256dh, auth}}`
- `barkServer String?` — bark 专用，自建服务器地址，null 表示公共 `api.day.app`

`barkServer` 放在设备上而不是机器上：device key 只对签发它的那台服务器有效，两台手机完全可能用不同服务器。

### 死设备判定

每种传输自己判断「这台设备永远不会再收到了」，因为判据完全不同，而误判的代价是**静默失联**——所以三处都取窄：

| | 回收 | 不回收 |
|---|---|---|
| apns | `Unregistered` / `BadDeviceToken` / `DeviceTokenNotForTopic` | 其余 |
| web | HTTP 404 / 410 | 429、5xx（可重试） |
| bark | HTTP 400 **且** 消息含 `failed to get device token` | 400 `device key is empty`（我们自己的 bug）、500（bark 连 APNs 失败） |

bark 那条特意匹配消息而不是状态码：bark-server 对「我们请求写错了」和「这个 key 不存在」都回 400，只有后者才该删用户的注册。

---

## Web Push 实现要点

零依赖，跟 `apns.ts` 同一套哲学（`node:crypto` 够用，`web-push` 会为了 ~120 行引入一整条 JOSE 依赖链）。涉及四个 RFC：

- **RFC 8291** 载荷加密：ECDH → HKDF ×2 → AES-128-GCM
- **RFC 8188** `aes128gcm` 分帧：`salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(65) ‖ 密文`
- **RFC 8292** VAPID：ES256 JWT，`Authorization: vapid t=<jwt>, k=<pubkey>`
- **RFC 8030** 请求头 `TTL` / `Urgency` / `Topic`

**加密这块用 RFC 8291 §5 的官方测试向量校验，不是自己跟自己 round-trip。** 这里的 bug 有个恶劣性质：info 字符串写错一个字节，照样能加密、照样上传成功、照样拿 201，然后在手机上解密成乱码、什么都不显示——自测 round-trip 会一路绿灯。所以 `webpush.test.ts` 固定同样的临时密钥和 salt，逐字节比对官方向量的输出。

几个容易踩的点，都在代码注释里标了：

- ES256 签名要 **raw r‖s**，Node 默认输出 DER —— 跟 `apns.ts` 踩过的是同一个坑
- `Topic` 头 RFC 8030 限 32 字符 URL-safe base64，我们的 collapseKey 更长，所以**取 hash 而不是截断**
- 每条消息必须换新的临时密钥 + salt。复用 (key, nonce) 是 AES-GCM 的完全破解，测试里专门盯着这条

### 载荷用 Declarative Web Push

服务端只发一种格式（Safari 18.4+ 的 `{web_push: 8030, notification: {...}}`）：

- iOS 18.4+ 浏览器**直接自己渲染**，不需要跑 service worker —— 既是可靠路径，也是 SW 起不来时的兜底
- 其他浏览器忽略这个标记，同一个对象走 `sw.js` 的 `push` handler
- 两边都可能触发时不会重复：`tag` 两条路径都取 `collapseKey`，同 tag 是**替换**而不是叠加

一个载荷同时服务两条路径，不用按 UA 分支。

---

## 落地清单

**服务端**
- `push/transport.ts` — `Transport` 接口 + 按 platform 分派；`apns.ts` 原样不动，适配器写在这里
- `push/bark.ts` / `push/webpush.ts` — 两个新传输
- `push/index.ts` — 扇出改为 `transportFor(d.platform).send(...)`
- `push/suppress.ts` — 导出 `isUrgentKind()`，让「值得吵醒你」和「值得穿透专注模式」共用一份名单
- `routers/push.ts` — 新增 `registerWeb` / `registerBark` / `list` / `remove`，`status` 返回各传输是否就绪 + VAPID 公钥
- migration `20260809120000_push_transports`

**前端**
- `public/sw.js` — `push` + `notificationclick`，`VERSION` v2→v3（否则旧 SW 不换）
- `lib/web-push-client.ts` — 订阅并**按 keyring 逐台机器注册**，跟 `native-bridge.ts` 同一个模式
- `app/push/page.tsx` — Settings → Push，两张卡 + 设备列表 + 测试按钮
- `lib/settings-nav.ts` — 加 tab

**测试**：`webpush.test.ts`（RFC 向量 + VAPID + 载荷形状）、`bark.test.ts`（请求形状 + 死键判定）、`transport.test.ts`（分派 + 配置检测）。

---

## 部署

```sh
# 1. Web Push：生成 VAPID 密钥对，写进 apps/dashboard/.env
cd apps/dashboard && npx tsx scripts/gen-vapid-keys.ts

# 2. 建表
npm run migrate

# 3. 私有 Bark（可选，但推荐：否则 api.day.app 能看到 agent 聊天摘要）
docker run -d --name bark -p 8080:8080 -v $PWD/bark-data:/data finab/bark-server
```

自建 bark-server **同样不需要 Apple 账号** —— 它内置了 Bark 自己的 APNs 密钥（topic `me.fin.bark`，keyID `LH4T9V5U4R`）。

手机侧：Safari 打开 dashboard → 分享 → 添加到主屏幕 → **从主屏图标打开** → Settings → Push → 开启。Bark 则是装 app、复制 device key、粘进同一页。

## 已知边界

- **Web Push 只在主屏 Web App 里可用。** Safari 标签页里 `PushManager` 根本不存在，所以 UI 把「没装到主屏」和「浏览器不支持」分成两种提示——前者用户能动手解决。
- **iOS 会回收长期未打开的订阅**，静默的。这是 Bark 存在的理由，不是可以修的 bug。
- **Bark 的通知点开走 Safari**，不是 PWA。要让 https 链接直接唤起 PWA 需要 universal link，而那需要一个原生 app 来认领——正好是本方案要避开的东西。
- **权限请求必须挂在真实点击上**，所以订阅按钮直接调 `subscribeWebPush()`，不放进 effect。
