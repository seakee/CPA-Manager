# CLI Proxy API 管理中心

[English](README.md)

这是面向 **CLI Proxy API（CPA）** 的单文件 Web 管理面板，并提供可选的 **Usage Service** 用于持久化请求统计。

CPA 上游已经移除内存聚合的 `/usage`、`/usage/export`、`/usage/import` 端点。当前方案通过常驻服务消费 CPA 的 Redis RESP 用量队列，把请求级事件写入 SQLite，并向面板提供兼容 `/usage` 的查询接口。

- **主项目**: https://github.com/router-for-me/CLIProxyAPI
- **示例地址**: https://remote.router-for.me/
- **推荐 CPA 版本**: >= 6.8.15

## 提供什么

- 面向 CPA Management API（`/v0/management`）的单文件 React 管理面板
- Docker 化 Usage Service，用 SQLite 持久化请求统计
- 两种部署模式：
  - **完整 Docker 方案**：访问 Usage Service 内置面板，登录时只填写 CPA 地址和 Management Key
  - **CPA 控制面板方案**：继续使用 CPA 的 `/management.html`，然后在面板中配置单独部署的 Usage Service 地址
- 运行时监控、账号/模型/渠道拆解、费用估算、导入导出、认证文件管理、配额视图、日志、配置编辑和系统工具

## 选择部署模式

| 模式 | 入口地址 | 用户需要配置 | 适用场景 |
|---|---|---|---|
| 完整 Docker 方案 | `http://<host>:18317/management.html` | 登录时填写 CPA 地址 + Management Key | 新部署、单入口、最少浏览器/CORS 问题 |
| CPA 控制面板方案 | `http://<cpa-host>:8317/management.html` | 在「系统信息 -> 外部用量统计服务」配置 Usage Service 地址 | 保留 CPA 自动载入面板的现有习惯 |
| 前端开发方案 | Vite dev server 或 `dist/index.html` | CPA 地址，可选 Usage Service 地址 | 本地开发 |

完整 Docker 方案不内置 CPA 本体。CPA 仍然作为上游服务独立运行；Docker 镜像提供 Usage Service 和内置管理面板。

## CPA 前置条件

请求统计依赖 CPA 的 Redis RESP 用量队列：

- CPA 必须启用 Management，因为 RESP 与 `/v0/management` 使用相同的可用性条件和 Management Key。
- 在 CPA 中启用用量发布：配置 `usage-statistics-enabled: true`，或通过 `PUT /usage-statistics-enabled` 提交 `{ "value": true }`。
- RESP 监听在 CPA API 端口，通常是 `8317`；如果 CPA API 启用了 HTTPS/TLS，RESP 也使用同一个 TLS listener。
- CPA 在内存中保留队列项的时间由 `redis-usage-queue-retention-seconds` 控制，默认 `60` 秒，最大 `3600` 秒。Usage Service 应保持常驻运行。
- 同一个 CPA 实例只应有一个 Usage Service 消费用量队列。

## 架构

### 完整 Docker 方案

```text
浏览器
  -> Usage Service :18317
      -> 内置 management.html
      -> /v0/management/usage 从 SQLite 返回
      -> 其他 /v0/management/* 反代到 CPA
      -> RESP 消费器 -> CPA API 端口
      -> SQLite /data/usage.sqlite
```

登录页会识别当前由 Usage Service 托管。你填写 CPA 地址和 Management Key 后，Usage Service 会验证 CPA Management API，保存设置到 SQLite，启动 RESP 采集器，并从同源提供完整管理面板。

### CPA 控制面板方案

```text
浏览器
  -> CPA /management.html
      -> 普通 CPA Management API 请求仍然访问 CPA
      -> usage 相关请求访问已配置的 Usage Service

Usage Service
  -> RESP 消费器 -> CPA API 端口
  -> SQLite /data/usage.sqlite
```

当你希望保留 CPA 自动下载并托管面板的机制时，使用这个方案。单独部署 Usage Service，然后在「系统信息 -> 外部用量统计服务」中启用并填写地址。

## 快速开始：完整 Docker 方案

### DockerHub 镜像

```bash
docker run -d \
  --name cpa-usage-service \
  --restart unless-stopped \
  -p 18317:18317 \
  -v cpa-usage-data:/data \
  seakee/cpa-usage-service:latest
```

打开：

```text
http://<host>:18317/management.html
```

填写：

- CPA 地址：
  - Docker Desktop 访问宿主机 CPA：`http://host.docker.internal:8317`
  - 同一 compose 网络：`http://cli-proxy-api:8317`
  - 远程 CPA：`https://your-cpa.example.com`
- Management Key

如果你的镜像发布在其他 DockerHub 命名空间，把 `seakee/cpa-usage-service:latest` 替换成实际镜像名。

### Docker Compose

```yaml
services:
  cpa-usage-service:
    image: seakee/cpa-usage-service:latest
    restart: unless-stopped
    ports:
      - "18317:18317"
    volumes:
      - cpa-usage-data:/data

volumes:
  cpa-usage-data:
```

启动：

```bash
docker compose up -d
```

### Linux 宿主机运行 CPA

如果 CPA 直接运行在 Linux 宿主机，Usage Service 运行在 Docker 中，需要添加 host gateway：

```bash
docker run -d \
  --name cpa-usage-service \
  --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -p 18317:18317 \
  -v cpa-usage-data:/data \
  seakee/cpa-usage-service:latest
```

然后 CPA 地址填写 `http://host.docker.internal:8317`。

## 快速开始：CPA 控制面板方案

1. 正常启动 CPA，打开：

   ```text
   http://<cpa-host>:8317/management.html
   ```

2. 单独部署 Usage Service：

   ```bash
   docker run -d \
     --name cpa-usage-service \
     --restart unless-stopped \
     -p 18317:18317 \
     -v cpa-usage-data:/data \
     seakee/cpa-usage-service:latest
   ```

3. 在 CPA 面板进入：

   ```text
   系统信息 -> 外部用量统计服务
   ```

4. 启用并填写：

   ```text
   http://<usage-service-host>:18317
   ```

5. 点击「保存并连接」。

面板会把当前 CPA 地址和 Management Key 发送给 Usage Service。之后监控页从 Usage Service 读取用量数据，其他管理功能仍然访问 CPA。

## 本地从源码构建

```bash
docker compose -f docker-compose.usage.yml up --build
```

该命令会构建 React 面板，并把它内置到 Go Usage Service 二进制中。

## Usage Service 配置项

大多数用户可以直接在面板中配置 CPA 地址和 Management Key。环境变量适合自动化部署。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `HTTP_ADDR` | `0.0.0.0:18317` | Usage Service HTTP 监听地址 |
| `USAGE_DB_PATH` | `/data/usage.sqlite` | SQLite 数据库路径 |
| `USAGE_DATA_DIR` | `/data` | 未覆盖 `USAGE_DB_PATH` 时的数据目录 |
| `CPA_UPSTREAM_URL` | 空 | 可选 CPA 地址，用于无人值守启动 |
| `CPA_MANAGEMENT_KEY` | 空 | 可选 CPA Management Key，用于无人值守启动 |
| `CPA_MANAGEMENT_KEY_FILE` | `/run/secrets/cpa_management_key` | 可选密钥文件 |
| `USAGE_RESP_QUEUE` | `usage` | RESP key 参数；当前 CPA 会忽略该值，除非上游行为变化，否则保持默认即可 |
| `USAGE_RESP_POP_SIDE` | `right` | `right` 使用 `RPOP`；`left` 使用 `LPOP` |
| `USAGE_BATCH_SIZE` | `100` | 每次最多弹出记录数 |
| `USAGE_POLL_INTERVAL_MS` | `500` | 队列空闲时轮询间隔 |
| `USAGE_QUERY_LIMIT` | `50000` | 兼容 `/usage` 最多返回的近期事件数 |
| `USAGE_CORS_ORIGINS` | `*` | CPA 控制面板方案下允许的浏览器来源 |
| `USAGE_RESP_TLS_SKIP_VERIFY` | `false` | RESP TLS 连接是否跳过证书校验 |
| `PANEL_PATH` | 空 | 使用自定义 `management.html` 替代内置面板 |

如果设置了 `CPA_UPSTREAM_URL` 和 `CPA_MANAGEMENT_KEY`，服务启动后会自动开始采集。否则通过面板 setup 流程配置。

## 数据与安全说明

- SQLite 数据存储在 `/data`，必须挂载到持久化 volume 或宿主机目录。
- 完整 Docker 方案会把 CPA 地址和 Management Key 保存到 SQLite `settings` 表，用于容器重启后恢复采集。
- 请保护 `/data` volume，它包含用量元数据和保存的 Management Key。
- Usage Service 会在保存 raw JSON 快照前脱敏疑似密钥字段，但请求元数据仍可能暴露模型、接口、账号标签和 token 用量。
- RESP 队列是弹出式消费，不要让多个 Usage Service 同时消费同一个 CPA 实例。
- 如果 Usage Service 停机超过 CPA 队列保留时间，该时段用量无法在不修改 CPA 的情况下恢复。

## 运行时接口

| 接口 | 用途 |
|---|---|
| `GET /health` | 基础健康检查 |
| `GET /status` | 采集器、SQLite、事件数、错误状态 |
| `GET /usage-service/info` | 让前端识别完整 Docker 方案 |
| `POST /setup` | 保存 CPA 地址和 Management Key，并启动采集 |
| `GET /v0/management/usage` | 面板兼容用量数据 |
| `GET /v0/management/usage/export` | JSONL 导出用量事件 |
| `POST /v0/management/usage/import` | JSONL 导入用量事件 |
| `/v0/management/*` | 除 usage 外反代到 CPA |

setup 后，用量和反代接口需要使用同一个 Management Key 作为 Bearer token。

## 功能概览

- **仪表盘**：连接状态、后端版本、快速健康概览
- **配置管理**：可视化和源码模式编辑 CPA 配置
- **AI 提供商**：Gemini、Codex、Claude、Vertex、OpenAI 兼容渠道、Ampcode
- **认证文件**：上传、下载、删除、状态、OAuth 排除模型、模型别名
- **配额管理**：支持提供商的配额视图
- **请求监控**：持久化用量 KPI、模型/渠道/账号拆解、失败分析、实时表格
- **Codex 账号巡检**：批量探测 Codex 认证池并给出清理建议
- **日志**：增量读取和筛选文件日志
- **系统信息**：模型列表、版本检查、本地状态工具、外部 Usage Service 配置

## 功能截图

![功能截图 1](img/image.png)

![功能截图 2](img/image_1.png)

![功能截图 3](img/image_2.png)

## 开发命令

前端：

```bash
npm install
npm run dev
npm run type-check
npm run lint
npm run build
```

Usage Service：

```bash
cd usage-service
go test ./...
go run ./cmd/cpa-usage-service
```

## 构建与发布

- Vite 输出单文件 `dist/index.html`
- 打 `vX.Y.Z` 标签会触发 `.github/workflows/release.yml`
- 发布流程会上传 `dist/management.html` 到 GitHub Releases
- 同一个 workflow 会构建 `Dockerfile.usage-service` 并推送到 DockerHub
- 必需 GitHub secrets：
  - `DOCKERHUB_USERNAME`
  - `DOCKERHUB_TOKEN`
- 可选 GitHub variable：
  - `DOCKERHUB_IMAGE`，例如 `your-org/cpa-usage-service`
- 如果未设置 `DOCKERHUB_IMAGE`，默认镜像名为 `<DOCKERHUB_USERNAME>/cpa-usage-service`

## 常见问题

- **完整 Docker 方案无法连接 CPA**：确认容器内能访问 CPA 地址。Linux 宿主机 CPA 需要 `--add-host=host.docker.internal:host-gateway`。
- **监控页为空**：确认 CPA 已启用使用统计，检查 Usage Service `/status`，并确认只有一个消费者。
- **Usage Service 返回 401**：使用 setup 时保存的同一个 Management Key。
- **Docker 面板数据不更新**：检查 `/status` 中的 `lastConsumedAt`、`lastInsertedAt`、`lastError`。
- **CPA 控制面板方案有 CORS 错误**：将 `USAGE_CORS_ORIGINS` 设置为 CPA 面板来源；私有部署可保持默认 `*`。
- **容器重建后数据丢失**：确认 `/data` 已挂载到 Docker volume 或宿主机目录。

## 参考

- CLIProxyAPI: https://github.com/router-for-me/CLIProxyAPI
- Redis 用量队列文档: https://help.router-for.me/management/redis-usage-queue.html

## 致谢

- 感谢 [Linux.do](https://linux.do/) 社区对项目推广与反馈的支持。

## 许可证

MIT
