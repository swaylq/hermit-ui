# 本机 `next build` 静态导出失败 — 调查记录

**结论先行：这不是仓库的问题，也不挡部署。** macOS 开发机上 `next build` 的**静态导出阶段**对**任何** Next app 都失败（包括一个两文件、零依赖、零配置的最小 app）；同一份仓库在 VPS 上构建正常，而部署本来就在 VPS 上构建。

本机验证请用 `npm run build:check`（见文末）。

---

## 症状

`next build` 编译通过，随后每个静态页面都失败：

```
✓ Compiled successfully in 2.4s
  Generating static pages using 9 workers (0/43) ...
Error occurred prerendering page "/brain". …
Error [InvariantError]: Invariant: Cannot access "entryCSSFiles" without a work store.
  This is a bug in Next.js.
```

**第一个误导**：并行 worker 会让构建提前退出，所以每次只看到少数几个页面失败，而且**每次页面都不同**——看起来像随机 flake。用 `next build --debug-prerender` 跑完整才发现是**全部 26 个静态页面都失败**，是系统性故障不是抖动。

**第二个误导**：早些时候构建是「成功」的（`✓ Generating static pages using 9 workers (43/43) in 147ms`）。43 个页面 147 毫秒是**全量缓存命中**，不是真渲染。开始 `rm -rf .next` 做冷构建后，一直存在的问题才暴露。

## 机制

错误来自 Next 自己的源码 `next/dist/server/app-render/manifests-singleton.js`：client-reference-manifest 是个 Proxy，读 `entryCSSFiles` / `entryJSFiles` / `moduleLoading` 时若 `workAsyncStorage.getStore()` 为空就抛这个 invariant（相邻的 `clientModules` 分支对同样情况是优雅降级的，所以只有这三个属性会炸）。

调用点（`get-css-inlined-link-tags.js` ← `create-component-styles-and-scripts` / `get-layer-assets` / `walk-tree-with-flight-router-state`）全都在 RSC 渲染内部。**渲染在跑，但里面读不到工作存储**——这是 `work-async-storage.external` 被加载成**两份实例**的典型表现（Next 用 `.external` 后缀就是为了保证全局唯一）。

为什么在 darwin-arm64 上会分叉成两份，没有继续深挖：它在 Next/Turbopack 的 worker 引导内部，属上游，且不影响任何实际产出（见下）。

## 排除了什么（每条都是单变量实测）

| 假设 | 做法 | 结果 |
|---|---|---|
| 仓库代码 | 两文件最小 app（只有 layout + page，无 CSS/依赖/配置） | ❌ 同样失败 |
| 工作区根目录推断错误 | 仓库被检出在一个含 `package-lock.json` 的目录里，Next 把根认成了 agent 目录 | ❌ 把 worktree 挪到无 lockfile 的祖先下（警告消失）仍失败 |
| 根目录下有第二份副本 | 把 worktree 挪出该目录 | ❌ 仍失败 |
| `next.config.ts` | 换成空配置 | ❌ 仍失败 |
| `turbopack.root` 未钉死 | 显式钉住 | ❌ 仍失败 |
| Node 版本 | Node 26.0.0 与 22.23.1 | ❌ 两个都失败 |
| 环境变量 | `env -i` 最小环境 | ❌ 仍失败 |
| `node_modules` 状态 | 全新隔离安装 + 硬链接副本 | ❌ 仍失败 |
| 原生二进制不匹配 | `@next/swc-darwin-arm64` 与 `next` 均为 16.2.6 | ❌ 无不匹配 |
| Next 版本 | 升到 16.2.12（最新） | ❌ 仍失败 |

顺带查明的两个无关噪音：
- `The "id" argument must be of type string` —— 隔离探针专有，真身是 **TypeScript 7 与 Next 不兼容**（`TypeScript 7.0.2 does not provide the compiler API required by Next.js`）。
- 探针一直装不上 TypeScript —— 因为 agent shell 里继承了 pm2 的 **`NODE_ENV=production`**，`npm i -D` 会**静默跳过 devDependencies**。这条坑值得单独记住。

## 为什么不挡部署

- `scripts/vps-deploy.sh` 在 **VPS 上**执行 pull → install → migrate → generate → build → restart，并且**先构建后重启**，构建失败不会动正在跑的 dashboard。
- VPS（Linux，Node v22.22.2）当天的 `apps/dashboard/.next/BUILD_ID` 时间戳正常产出 —— 导出阶段在那边是好的。

也就是说：**生产构建从来不在这台 Mac 上跑**，本机这个故障只影响「我想在本地跑一次完整 build 当验证」这件事。

## 本机怎么验证

```sh
npm run build:check     # next build --experimental-build-mode compile
```

实测 EXIT=0，并正常打印 Route 表。它跑完编译、TypeScript 检查和路由收集——也就是能抓到坏 import、类型错误、路由写错——在跑不动的导出阶段之前停下。

**它覆盖不到的**：server component 的预渲染期运行时错误。本 app 里这块很薄（每个页面都是 `AuthGate` 后面的 client component），但确实是个缺口，由 VPS 的构建兜住。

## 如果以后要继续查

从这里接着走：为什么 darwin-arm64 的导出 worker 会拿到第二份 `work-async-storage.external` 实例。可用的下一步是给 Next 的 worker 引导打点，确认两份实例的解析路径（CJS `dist/server/...` vs ESM `dist/esm/server/...`），或者在 Next 仓库搜同类 issue。**在此之前不要因为这条重跑一遍上面的排除表。**
