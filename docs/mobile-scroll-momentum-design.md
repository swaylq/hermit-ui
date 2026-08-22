# 移动端上滑「一顿一顿」：momentum 被 scrollTop 写掉

2026-08-22 · dashboard · 第一段已实现（`812ddc1`），第二段待评审

## 症状与前情

`4cfa0ad` 之后手机上滑不再突变，但 sway 报「有一点一顿一顿」——不是掉帧率低，
是**周期性地卡一下**：滑一下走一小段，停住，再滑再走。

## 怎么量的

`asst/scripts/browser/mobile-scroll-smoothness.js`：WebKit（iOS Safari 同族引擎，
Chrome 测不出来）+ 390×844 视口 + 真实的浏览器平滑滚动（不是注入 wheel——wheel 是
一次协议往返，它的到达节奏会冒充页面的卡顿）。页内同一条 `performance.now()` 时钟上
记四样东西：每帧时间、`scrollTop` 的每一次程序化写入（连 `scrollTo`/`scrollBy` 一起
劫持）、每次 fetch 的发出与落地、挂载行数。于是每个长帧都能归因。

## 根因（两条，第一条已修）

**一、settle 窗口变成了每帧一次写。** 线上实测：一次 load earlier 之后，5,000px 的
平滑滚动只走了 2,785px，在 **253ms 处停死**，接下来页面在 **93 个连续帧上写
`scrollTop`**，每一次实际位移都是 **0px**。

iOS 的滚动由引擎之外的 UIScrollView 跑，赋值 `scrollTop` 等同 `setContentOffset`，
**会终止惯性滚动**。所以亚像素修正不是「便宜地牺牲一点精度」，而是「用整个 fling 换
零像素」。两种写不下去还一直重发的情况：`scrollTop` 是量化的，不足一像素读回来纹丝不
动；视口在 0 或末端被 clamp，修正无处可去。旧代码把计划里的 `offset` 原样存回，没人
记录「这次没落地」，于是下一帧算出同样的修正，再写一次。

修法（已实现）：`settledHold()` 采纳实际发生的位移，写入阈值提到整像素，rAF 泵在连续
6 帧无事可做后休眠（ResizeObserver 和每片 commit 会叫醒它），`isHolding()` 自己检查
截止时间。实测同一条会话、同一次上滑：**每次 sweep 的写入 93 次 → 1~2 次**。

**二、剩下的每一次写，还是一次 momentum 谋杀。** 修完之后的 sweep 仍然在 239ms /
374ms / 96ms 处停死，对应的正是 prepend 落地时那一笔真实修正（1,578px、2,777px、
2,543px）。一页历史 60 条、分 2 片 commit，就是 2 次；一次 fling 常常连拉 2~3 页，
于是一个手势里有 4~6 次惯性被掐断——这就是「一顿一顿」。

## 排除掉的（别再试）

同一条会话、同一次 sweep，逐个关掉再测（`mobile-scroll-ablation.js`）：

| 变体 | 中位 | p90 | 最差 | >32ms |
|---|---|---|---|---|
| 基线 | 17ms | 18ms | 114ms | 2/134 |
| 关掉全部 `backdrop-filter` | 17 | 18 | 225 | 2/131 |
| 关掉气泡的 `box-shadow` / 圆角 | 17 | 19 | 114 | 4/133 |
| 隐藏悬浮按钮（`.fixed`） | 17 | 19 | 65 | 2/140 |
| 三者全关 | 17 | 19 | 66 | 4/136 |

**都在噪声里**。悬浮的麦克风 / 预览按钮带 `backdrop-blur-xl` 且盖在滚动内容上，本来是
个合理怀疑（WebKit 每合成帧都要重算被模糊的背景），数据否掉了它。IndexedDB 的同步部分
一次 sweep 合计 3~28ms，也不是。剩下的 2~4 个长帧（60~240ms）在全关的情况下照旧出现，
是引擎自己的光栅化，暂时没有便宜的解。

## 待实现：把修正付给布局，而不是付给滚动偏移

三个成熟虚拟列表都在 iOS 上绕开 `scrollTop`：virtua 和 TanStack Virtual 把修正累积成
`pendingJump`，滚动停下才落；react-virtuoso 更进一步，用一个 `deviation` 作为容器的
`margin-top` 吸收掉，**根本不碰滚动偏移**。后者正好贴合本仓的结构。

做法：时间线正文最上方放一个我们自己的空 div，`margin-top: -D`。

- prepend 落地、锚点算出 `correction` 时，如果用户正在滑（最近 150ms 内有 scroll 事件，
  或手指还在屏幕上），就把 `D += correction` 而不是写 `scrollTop`。负 margin 把后面的
  内容整体上提同样的距离——**视觉上和写 `scrollTop` 完全等价，惯性毫发无伤**。
- 代价：`scrollHeight` 在这段时间里不增长，所以这一次 fling 滑不进刚到的那段历史，会停
  在原来的顶部。因为拉取提前两屏触发，接缝通常还在两屏之外，滑到就停是正常观感。
- 滚动停下（无 scroll 事件 200ms 且无触点）时同一帧内解开：`scrollTop += D` 且
  `D = 0`。视觉零变化，滚动范围恢复。硬上限 2s，避免一直滑一直不解。

必须一起改的四处：

1. `use-prepend-anchor` —— 付款走 deviation 还是 `scrollTop`；解开时同步刷新
   `hold.lastTop`，否则下一帧会把这 D 像素读成「用户往下滚了」。
2. `use-timeline-window` —— `planWindow` 在「自然坐标」里工作，deviation 生效期间要传
   `scrollTop + D`，否则窗口挂错行。
3. `chat/page.tsx` —— 解开那一次写要包在 `autoScrollRef` 里，不然滚动监听会当成用户
   意图；`pullMargin` 的「离顶多远」判据同样要补上 D。
4. 测试 —— deviation 的加减与解开写成纯算术加单测；回归断言：任何时刻
   `visualOffset = scrollTop + D` 连续，即解开前后视觉位置不变。

### 为什么不用别的

- **`overflow-anchor: auto`**：WebKit 的 scroll anchoring 确实在 2026-02 落地
  （bug 307734），但要等下一个 stable Safari，装在主屏的 PWA 更晚；而且 base-ui 的
  viewport 明确设了 `overflow-anchor: none`，本仓「非我方写入即用户」的铁律建立在这条
  之上，翻掉它要重做锚点的全部推理。将来当渐进增强加。
- **顶部预留一段 spacer**（prepend 时按页高收缩，闲时补回）：等价效果，但预留的是**空白**，
  读者滑到那里会看见一段空区，且历史读完时收不掉。deviation 没有这个问题。
- **一页一次 commit（不分片）**：把每页 2 次谋杀减成 1 次，但 60 行一次解析会超过一帧。
  在 iOS 上「掉一帧」不可见（滚动在 UI 线程）、「掐断惯性」很可见，所以理论上划算——但
  无头 WebKit 的滚动跑在主线程，量不出这个差别，不能靠推理翻。

## 验证

- 单测：deviation 的加减解开；`prepend-anchor-core` 现有不变量继续全绿。
- 探针：`mobile-scroll-smoothness.js` 的 sweep，判据是**平滑滚动走完 5,000px 全程**
  （今天是 239ms 处停在 2,785px）。
- 真机：只有 sway 的手机能判「惯性有没有被掐」，无头 WebKit 的滚动在主线程，测不出。
  所以第二段落地后要等一次真机反馈再往下做。
