# CLI Proxy API Management Center

[中文文档](README_CN.md)

A single-file Web UI for **CLI Proxy API (CPA)** plus an optional **Usage Service** for persistent usage analytics.

The CPA memory aggregation endpoints (`/usage`, `/usage/export`, `/usage/import`) have been removed upstream. This project now supports usage analytics through a long-running service that consumes the CPA Redis RESP usage queue, persists request events to SQLite, and exposes `/usage`-compatible APIs for the panel.

- **Main project**: https://github.com/router-for-me/CLIProxyAPI
- **Example URL**: https://remote.router-for.me/
- **Recommended CPA version**: >= 6.8.15

## What This Provides

- A single-file React management panel for CPA Management API (`/v0/management`)
- A Dockerized Usage Service for SQLite-backed usage persistence
- Two deployment modes:
  - **Full Docker mode**: open the built-in panel from Usage Service and only enter the CPA URL + Management Key
  - **CPA panel mode**: keep using CPA's `/management.html`, then configure a separately deployed Usage Service inside the panel
- Runtime monitoring, account/model/channel breakdowns, estimated cost, imports/exports, auth-file operations, quota views, logs, config editing, and system utilities

## Choose a Deployment Mode

| Mode | Entry URL | What the user configures | Best for |
|---|---|---|---|
| Full Docker mode | `http://<host>:18317/management.html` | CPA URL + Management Key on login | New deployments, one entry point, least browser/CORS complexity |
| CPA panel mode | `http://<cpa-host>:8317/management.html` | Usage Service URL under **System -> External Usage Service** | Existing CPA automatic panel loading |
| Frontend only | Vite dev server or `dist/index.html` | CPA URL, optionally Usage Service URL | Development |

Full Docker mode does not bundle CPA itself. CPA still runs as the upstream service; the Docker image provides the Usage Service plus an embedded copy of this management panel.

## CPA Prerequisites

Request statistics require the CPA Redis RESP usage queue:

- CPA Management must be enabled because RESP uses the same availability and Management Key as `/v0/management`.
- Enable usage publishing in CPA with `usage-statistics-enabled: true`, or through `PUT /usage-statistics-enabled` with `{ "value": true }`.
- The RESP listener is on the CPA API port, usually `8317`; if CPA uses HTTPS/TLS, RESP uses the same TLS listener.
- CPA keeps queue items in memory for `redis-usage-queue-retention-seconds`, default `60` seconds and maximum `3600` seconds. Keep Usage Service running continuously.
- Exactly one Usage Service should consume the same CPA usage queue.

## Architecture

### Full Docker Mode

```text
Browser
  -> Usage Service :18317
      -> built-in management.html
      -> /v0/management/usage from SQLite
      -> other /v0/management/* proxied to CPA
      -> RESP consumer -> CPA API port
      -> SQLite /data/usage.sqlite
```

The login page detects that it is hosted by Usage Service. You enter the CPA URL and Management Key. Usage Service validates the CPA Management API, stores the setup in SQLite, starts the RESP collector, and serves the panel from the same origin.

### CPA Panel Mode

```text
Browser
  -> CPA /management.html
      -> normal CPA Management API calls stay on CPA
      -> usage calls go to configured Usage Service URL

Usage Service
  -> RESP consumer -> CPA API port
  -> SQLite /data/usage.sqlite
```

Use this when CPA still auto-downloads and serves the panel. Deploy Usage Service separately, then open **System -> External Usage Service**, enable it, enter the Usage Service URL, and save.

## Quick Start: Full Docker Mode

### DockerHub Image

```bash
docker run -d \
  --name cpa-usage-service \
  --restart unless-stopped \
  -p 18317:18317 \
  -v cpa-usage-data:/data \
  seakee/cpa-usage-service:latest
```

Open:

```text
http://<host>:18317/management.html
```

Enter:

- CPA URL:
  - Docker Desktop host CPA: `http://host.docker.internal:8317`
  - Same compose network: `http://cli-proxy-api:8317`
  - Remote CPA: `https://your-cpa.example.com`
- Management Key

If your image is published under another DockerHub namespace, replace `seakee/cpa-usage-service:latest`.

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

Start:

```bash
docker compose up -d
```

### Linux Host CPA

If CPA runs directly on a Linux host and Usage Service runs in Docker, add a host gateway:

```bash
docker run -d \
  --name cpa-usage-service \
  --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -p 18317:18317 \
  -v cpa-usage-data:/data \
  seakee/cpa-usage-service:latest
```

Then enter `http://host.docker.internal:8317` as the CPA URL.

## Quick Start: CPA Panel Mode

1. Start CPA as usual and open:

   ```text
   http://<cpa-host>:8317/management.html
   ```

2. Deploy Usage Service:

   ```bash
   docker run -d \
     --name cpa-usage-service \
     --restart unless-stopped \
     -p 18317:18317 \
     -v cpa-usage-data:/data \
     seakee/cpa-usage-service:latest
   ```

3. In the CPA panel, go to:

   ```text
   System -> External Usage Service
   ```

4. Enable it and enter:

   ```text
   http://<usage-service-host>:18317
   ```

5. Click **Save and connect**.

The panel sends the current CPA URL and Management Key to Usage Service. After that, monitoring reads usage data from Usage Service while other management calls continue to use CPA.

## Build Locally

```bash
docker compose -f docker-compose.usage.yml up --build
```

This builds the React panel and embeds it into the Go Usage Service binary.

## Usage Service Configuration

Most users can configure CPA URL and Management Key from the panel. Environment variables are useful for automated deployments.

| Variable | Default | Description |
|---|---:|---|
| `HTTP_ADDR` | `0.0.0.0:18317` | Usage Service HTTP listen address |
| `USAGE_DB_PATH` | `/data/usage.sqlite` | SQLite database path |
| `USAGE_DATA_DIR` | `/data` | Base data directory when `USAGE_DB_PATH` is not overridden |
| `CPA_UPSTREAM_URL` | empty | Optional CPA base URL for unattended startup |
| `CPA_MANAGEMENT_KEY` | empty | Optional CPA Management Key for unattended startup |
| `CPA_MANAGEMENT_KEY_FILE` | `/run/secrets/cpa_management_key` | Optional file containing the Management Key |
| `USAGE_RESP_QUEUE` | `usage` | RESP key argument; CPA currently ignores it, leave the default unless upstream changes |
| `USAGE_RESP_POP_SIDE` | `right` | `right` uses `RPOP`; `left` uses `LPOP` |
| `USAGE_BATCH_SIZE` | `100` | Maximum queue records per pop |
| `USAGE_POLL_INTERVAL_MS` | `500` | Idle polling interval |
| `USAGE_QUERY_LIMIT` | `50000` | Maximum recent events returned through compatible `/usage` |
| `USAGE_CORS_ORIGINS` | `*` | Allowed browser origins for CPA panel mode |
| `USAGE_RESP_TLS_SKIP_VERIFY` | `false` | Skip TLS verification for RESP connection |
| `PANEL_PATH` | empty | Serve a custom `management.html` instead of the embedded one |

If `CPA_UPSTREAM_URL` and `CPA_MANAGEMENT_KEY` are set, collection starts automatically on boot. Otherwise, use the web panel setup flow.

## Data and Security Notes

- SQLite data is stored under `/data`; mount it to persistent storage.
- In full Docker mode, CPA URL and Management Key are stored in the SQLite `settings` table so collection can resume after restart.
- Protect the `/data` volume. It contains usage metadata and the saved Management Key.
- Usage Service redacts key-like fields before storing raw JSON payload snapshots, but request metadata may still expose models, endpoints, account labels, and token usage.
- RESP queue consumption is pop-based. Do not run multiple Usage Service consumers against the same CPA instance.
- If Usage Service is down longer than CPA's queue retention window, that period's usage cannot be recovered without CPA-side persistence.

## Runtime Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Basic health check |
| `GET /status` | Collector, SQLite, event count, and error status |
| `GET /usage-service/info` | Allows the frontend to detect full Docker mode |
| `POST /setup` | Save CPA URL + Management Key and start collection |
| `GET /v0/management/usage` | Compatible usage payload for the panel |
| `GET /v0/management/usage/export` | Export usage events as JSONL |
| `POST /v0/management/usage/import` | Import JSONL usage events |
| `/v0/management/*` | Proxied to CPA except usage endpoints |

Usage and proxy endpoints require the same Management Key as a Bearer token after setup.

## Feature Overview

- **Dashboard**: connection state, backend version, quick health summary
- **Configuration**: visual and source editing for CPA configuration
- **AI Providers**: Gemini, Codex, Claude, Vertex, OpenAI-compatible providers, and Ampcode
- **Auth Files**: upload, download, delete, status, OAuth exclusions, model aliases
- **Quota**: quota views for supported providers
- **Request Monitoring**: persisted usage KPIs, model/channel/account breakdowns, failure analysis, realtime tables
- **Codex Account Inspection**: batch probing and cleanup suggestions for Codex auth pools
- **Logs**: incremental file log reading and filtering
- **System**: model list, version checks, local state tools, external Usage Service configuration

## Screenshots

![Feature screenshot 1](img/image.png)
![Feature screenshot 2](img/image_1.png)
![Feature screenshot 3](img/image_2.png)

## Development

Frontend:

```bash
npm install
npm run dev
npm run type-check
npm run lint
npm run build
```

Usage Service:

```bash
cd usage-service
go test ./...
go run ./cmd/cpa-usage-service
```

## Build and Release

- Vite builds a single-file `dist/index.html`.
- Tagging `vX.Y.Z` triggers `.github/workflows/release.yml`.
- The release workflow uploads `dist/management.html` to GitHub Releases.
- The same workflow builds `Dockerfile.usage-service` and pushes to DockerHub.
- Required GitHub secrets:
  - `DOCKERHUB_USERNAME`
  - `DOCKERHUB_TOKEN`
- Optional GitHub variable:
  - `DOCKERHUB_IMAGE`, for example `your-org/cpa-usage-service`
- Without `DOCKERHUB_IMAGE`, the default image is `<DOCKERHUB_USERNAME>/cpa-usage-service`.

## Troubleshooting

- **Cannot connect in full Docker mode**: verify the CPA URL from inside the Usage Service container. For host CPA on Linux, use `--add-host=host.docker.internal:host-gateway`.
- **Monitoring is empty**: enable CPA usage statistics, verify Usage Service `/status`, and confirm only one consumer is running.
- **401 from Usage Service**: use the same Management Key that was saved during setup.
- **Docker panel shows stale data**: check `/status` for `lastConsumedAt`, `lastInsertedAt`, and `lastError`.
- **CPA panel mode has CORS errors**: set `USAGE_CORS_ORIGINS` to the CPA panel origin or keep the default `*` for private deployments.
- **Data disappears after container rebuild**: mount `/data` to a Docker volume or host directory.

## References

- CLIProxyAPI: https://github.com/router-for-me/CLIProxyAPI
- Redis usage queue documentation: https://help.router-for.me/management/redis-usage-queue.html

## Acknowledgements

- Thanks to the [Linux.do](https://linux.do/) community for project promotion and feedback.

## Thanks

[Linux Do](https://linux.do/)

## License

MIT
