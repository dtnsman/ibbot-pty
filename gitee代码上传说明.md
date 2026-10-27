# Gitee 代码上传说明

本文档说明如何将本项目（IBBot PTY Manager）发布到 Gitee，以及上传范围、脱敏要求与操作步骤。

## 一、上传范围

| 内容 | 是否上传 | 说明 |
|---|---|---|
| `client/` | ✅ | SDK 源码、dist 构建产物、独立 Agent 脚本、示例 |
| `server/` | ✅ | 服务入口、src、test、package.json |
| 静态文件 | ⚠️ 仅 `client/demo-hosts.html` | **其他静态文件一律不允许上传** |
| `server/setting/` | ⚠️ 仅空白模板 | 只上传 `rtptyx_setting.template.json` |
| `node_modules/`、`.svn/` | ❌ | 本地目录与版本控制缓存 |
| `开源项目隐私保护说明.md` | ❌ | 内部审计文档，不发布 |

## 二、上传前检查清单

1. **敏感信息扫描**：确认 `secret_key`、`server-id`、令牌、私钥路径均未入库。
2. **配置模板**：`server/setting/rtptyx_setting.template.json` 中 `secret_key` 必须为空字符串。
3. **静态文件**：确认 `client/` 下除 `demo-hosts.html` 外无其他静态资源被提交。
4. **忽略规则**：`.gitignore` 已排除 `node_modules/`、`server/setting/rtptyx_setting.json`、`server/setting/server-id` 等。

## 三、上传步骤

### 1. 准备发布目录

在源工作区执行（PowerShell）：

```powershell
$src = 'E:\dtns.pty'
$root = 'E:\dtns.pty\opensource'
# 复制 client / server，排除 node_modules
robocopy "$src\ibbot-pty-sdk" "$root\client" /E /XD node_modules
robocopy "$src\dtns.pty-server" "$root\server" /E /XD node_modules
```

### 2. 清理静态文件与敏感配置

- 仅保留 `client/demo-hosts.html`，删除其余静态文件。
- 清空 `server/setting/rtptyx_setting.json` 中的 `secret_key`，重命名为 `rtptyx_setting.template.json`。
- 删除 `server/setting/server-id`。

### 3. 初始化仓库并提交

```bash
cd E:\dtns.pty\opensource
git init
git add .
git commit -m "chore: initial open source release v1.0.0"
```

### 4. 关联 Gitee 远程仓库

```bash
git remote add origin https://gitee.com/dtnsman/ibbot-pty.git
git branch -M main
git push -u origin main
```

> 凭据使用私人令牌（保存在本机 `C:\Users\FIREBAT\.ssh\` 下），**切勿写入仓库或提交到任何文件**。

### 5. 验证

```bash
git status           # 应显示 working tree clean
git ls-remote origin # 确认远端已有提交
git log --oneline -1 # 确认提交信息
```

## 四、常见问题

| 问题 | 处理方式 |
|---|---|
| `No such remote: 'origin'` | 说明远程未添加，执行 `git remote add origin <url>` |
| 推送被拒绝 / 认证失败 | 检查令牌是否有效、是否有该仓库写权限 |
| 误提交了敏感文件 | 立即 `git rm --cached <file>`，提交后**轮换对应密钥** |
| 静态文件被包含 | 从工作副本删除并提交，确认 `.gitignore` 未误放行 |

## 五、后续维护约定

1. 每次发布在「发布纪录」表格追加一行，注明版本号、日期与变更要点。
2. 发布前必须执行敏感信息扫描。
3. 新增静态文件需经确认后方可纳入开源范围。

## 发布纪录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0.0 | 2026-10-27 | 首次开源发布：整理 client / server 源码，静态文件仅保留 `demo-hosts.html`，`server/setting/` 仅提供空白模板配置 `rtptyx_setting.template.json`，完成敏感信息脱敏与扫描；创建 Gitee 仓库 `dtnsman/ibbot-pty` 并推送初始提交 `09e226a` |
| v1.0.0 | 2026-10-27 | 补充上传说明文档 `gitee代码上传说明.md`，提交 `61f8c6f` |
| v1.0.0 | 2026-10-27 | 开源协议由 MIT 切换为 GPLv3，同步更新 LICENSE、README、开源说明、`client/package.json` 与 rollup 构建 banner，提交 `1f7e176` |
| v1.0.0 | 2026-10-27 | 同步发布到 GitHub：https://github.com/dtnsman/ibbot-pty ，Gitee 作为主仓库保留 |