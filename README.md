# IBBot PTY Manager

基于 WebSocket 的远程 PTY（伪终端）管理套件，支持多主机、多终端、文件传输与 SSH 隧道穿透。

## 目录结构

```
opensource/
├── client/                 # 前端 SDK（ibbot-pty-sdk）
│   ├── src/                # 源码（ES Module）
│   ├── dist/               # 构建产物（UMD / ESM / CJS）
│   ├── js/                 # 独立 Agent 脚本
│   ├── demo-hosts.html     # 演示页面（唯一允许发布的静态文件）
│   ├── node-demo.js        # Node.js 使用示例
│   ├── package.json
│   └── rollup.config.js
├── server/                 # 后端服务（ibbot-pty-server）
│   ├── server.js           # 入口
│   ├── src/                # 会话 / 网关 / 后端 / 隧道
│   ├── setting/
│   │   └── rtptyx_setting.template.json   # 空白模板配置
│   ├── test/
│   └── package.json
├── LICENSE
└── 开源说明.md
```

> 静态文件仅发布 `client/demo-hosts.html`，其余静态资源不在开源范围内。
> `server/setting/` 下只提供空白模板，运行时请复制为 `rtptyx_setting.json` 并自行填写。

## 快速开始

### 服务端

```bash
cd server
npm install
# 复制模板配置并填写 secret_key 等字段
copy setting\\rtptyx_setting.template.json setting\\rtptyx_setting.json
npm start
```

### 客户端

```bash
cd client
npm install
npm run build     # 重新构建 dist
```

浏览器中打开 `client/demo-hosts.html` 即可体验（页面通过 CDN 加载 xterm，本地依赖 `dist/ibbot-pty.umd.js`）。

## 配置说明

`server/setting/rtptyx_setting.template.json` 中的关键字段：

| 字段 | 说明 |
|---|---|
| `port` | WebSocket 服务监听端口 |
| `secret_key` | 连接鉴权密钥（**必填**，请自行生成强随机值） |
| `max_terminals` | 单会话最大终端数 |
| `idle_timeout` | 空闲超时（秒，0 为不限制） |
| `ssh` | SSH 后端连接参数 |

## 安全提示

- 切勿将填写过真实密钥的 `rtptyx_setting.json`、`server-id` 提交到仓库（`.gitignore` 已排除）。
- 建议在生产环境前置反向代理并启用 TLS（`wss://`）。

## 许可证

[GNU General Public License v3.0](LICENSE)（GPLv3）

本项目采用 GPLv3 开源协议发布，任何再分发或修改后的作品都必须以相同协议开源，并保留完整的版权声明。
