# Secrets — 加密统一凭据（全 agent 共享）

所有 token / 密码 / API key 统一存在加密文件 `~/.claude/global-memory/secrets.age`（`age` 加密、密文；master 私钥在 macOS Keychain `hermit-secrets-age`，无则回退 `~/.claude/hermit-secrets-identity.txt`（600）；本机每个 agent 都能解密）。用 `secret` CLI 读写。

新机器初始化：`secret init`（详见 hermit-ui `apps/gateway/scripts/secret/README.md`）。

## 读（agent 用这个）
- `secret list` — 看有哪些 key（只名字，无值）
- `secret exec KEY [KEY...] -- <命令>` — 把 KEY 注入命令的环境变量再跑，**值不进 stdout/transcript**。首选。
  - 让命令自己从 env 读，别把 `$KEY` 拼进命令行（会进 `ps`）。例：`secret exec GH_TOKEN -- sh -c 'gh api ...'`、`secret exec BRAVE_API_KEY -- some-tool`（工具内部读 `$BRAVE_API_KEY`）。
- `secret exec -- <命令>` — 注入全部 secret 跑命令

## 写
- `printf %s '<值>' | secret set KEY` — 值从 **stdin**（**绝不**把值放命令行）

### 多行的值（`.p8`、PEM 私钥、证书、配置文件）必须先编码

store 是一行一个 `KEY=VALUE`，**带换行的值会被存坏**：只有第一行读得回来，其余几行留在文件里成为
读不到的孤行。2026-09-04 一把 App Store Connect 上传密钥就是这么丢的——`secret set` 报了成功、
`secret list` 里也在，取出来只剩 `-----BEGIN PRIVATE KEY-----` 一行。现在 `set` 会直接拒绝并提示，
但**约定要记住**：多行一律 base64 存成 `<KEY>_B64`。

```sh
base64 <AuthKey_XXXX.p8 | tr -d '\n' | secret set ASC_KEY_P8_B64      # 存
secret exec ASC_KEY_P8_B64 -- sh -c \
  'printf %s "$ASC_KEY_P8_B64" | base64 -d >"$TMPDIR/k.p8" && some-tool "$TMPDIR/k.p8"'   # 用
```

## 安全铁律
- **绝不** `echo $KEY` / 把值写进 reply、memory、日志、commit。要证明凭据有效，就用它跑命令、报 HTTP 状态，不报值本身。
- `secret get` / `secret load` 会打印明文值 —— 只给 sway 手动用，**agent 不用**。
- 不知道某凭据在不在 store：`secret list`。不在就问 sway，**别去文件系统爬 token**。

## 现有 key（清单，无值 · `secret list` 看实时）
| key | 用途 |
|---|---|
| `BRAVE_API_KEY` | Brave Search API |
| `NPM_TOKEN` | npm publish（`~/.npmrc` 用 `${NPM_TOKEN}`，publish 走 `secret exec NPM_TOKEN -- npm publish`） |
| `RATHOLE_TOKEN` | rathole 隧道 token |
| `ROUTER_PW` | OpenWrt 路由器 192.168.2.1 |
| `VPS_SUDO_PW` | VPS 45.89.234.110 sudo |
| `SWAY003_SUDO_PW` | sway003-macmini sudo |
| `ZHINAN_PORTAL_USER` / `ZHINAN_PORTAL_PW` | 执楠 cms/pms/autodeploy 登录 |
| `ZHINAN_GITLAB_USER` / `ZHINAN_GITLAB_PW` | 执楠 gitlab |
| `ZHINAN_MAIN_SUDO_PW` | zhinan-main 139.198.179.233 sudo |
