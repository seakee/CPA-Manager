# CLI Proxy API Management Center

A single-file Web UI (React + TypeScript) for operating, observing, and troubleshooting **CLI Proxy API** through its **Management API**.

It covers configuration, providers, auth files, OAuth flows, quota views, usage analytics, runtime monitoring, logs, and system utilities in one place.

[中文文档](README_CN.md)

**Main Project**: https://github.com/router-for-me/CLIProxyAPI  
**Example URL**: https://remote.router-for.me/  
**Minimum Backend Version**: >= 6.8.0 (recommended >= 6.8.15)

Since `6.0.19`, the Web UI ships with the main program. Once the service is running, open `/management.html` on the API port.

## What this is

- This repository is the Web UI only.
- It talks to the CLI Proxy API **Management API** (`/v0/management`) to read and update runtime state.
- It is **not** a proxy and does not forward traffic itself.

## Highlights on this branch

### Request Monitoring Center

The current branch adds a dedicated runtime monitoring experience under `/monitoring`.

- Aggregates `/usage`, `auth-files`, and `openai-compatibility` data into one view
- Tracks model-call volume, success and failure, token structure, latency, estimated cost, RPM/TPM, and approximate task buckets
- Provides account, model, channel, and failure breakdowns with live filters and auto refresh
- Includes account-level drill-down and live Codex quota lookups

### Codex Account Inspection

The current branch also adds `/monitoring/codex-inspection` for operational cleanup of Codex auth files.

- Probes Codex accounts in batch
- Detects invalid accounts, quota exhaustion, and disabled-account recovery candidates
- Suggests `delete`, `disable`, or `enable` actions per account
- Supports batch execution, single-item execution, sampling, concurrency, timeout, retries, and optional post-run auto execution
- Can inherit defaults from server-side `clean` config when available, while persisting browser-side overrides locally

### Better auth/account compatibility

Supporting changes on this branch improve several backend compatibility edges:

- Better Codex account ID resolution across different auth-file shapes
- More robust disabled-state detection
- Safer handling when `/api-call` returns no explicit status code
- Additional auth-file mutation fallbacks for enable/disable/delete flows

## Screenshots

Monitoring and inspection UI added on this branch:

![Feature screenshot 1](img/image.png)
![Feature screenshot 2](img/image_1.png)
![Feature screenshot 3](img/image_2.png)

## Quick start

### Option A: Use the bundled Web UI in CLI Proxy API

1. Start your CLI Proxy API service.
2. Open `http://<host>:<api_port>/management.html`.
3. Enter your **management key** and connect.

The UI auto-detects the API address from the current page URL and also allows manual override.

### Option B: Run the dev server

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` and connect it to your CLI Proxy API backend.

### Option C: Build a single HTML file

```bash
npm install
npm run build
```

- Output: `dist/index.html`
- Assets are inlined into a single file
- Release packaging can rename it to `management.html`
- Local preview: `npm run preview`

Tip: opening `dist/index.html` with `file://` may run into browser CORS restrictions. Serving it through a local HTTP server is more reliable.

## Connecting to the server

### API address

The UI normalizes any of the following inputs:

- `localhost:8317`
- `http://192.168.1.10:8317`
- `https://example.com:8317`
- `http://example.com:8317/v0/management`

### Management key

The management key is sent with requests as:

- `Authorization: Bearer <MANAGEMENT_KEY>`

This is different from the proxy `api-keys` managed in the UI. Those keys are for clients calling the proxy endpoints.

### Remote management

If you connect from a non-localhost browser, the server must allow remote management, for example:

- `allow-remote-management: true`

Authentication rules, rate limits, and remote-access blocking are enforced server-side.

## Feature overview

- **Dashboard**
  - Connection status, backend version, build date, and quick health summary
- **Configuration**
  - Core config switches such as debug mode, proxy URL, retries, quota fallback, usage statistics, request logging, file logging, WebSocket auth, and in-browser `/config.yaml` editing
- **AI Providers**
  - Gemini, Codex, Claude, Vertex, OpenAI-compatible providers, and Ampcode integration
- **Auth Files**
  - Upload, download, delete, search, pagination, runtime-only indicators, enable and disable workflows, OAuth excluded models, and OAuth model alias mappings
- **OAuth**
  - OAuth and device-code flows for supported providers, plus iFlow cookie import
- **Quota**
  - Quota views and management for Claude, Antigravity, Codex, Gemini CLI, and other providers
- **Request Monitoring**
  - Runtime KPIs, trend charts, token mix, model and channel rankings, failure spotlight, account overview, live filters, and realtime monitor tables
- **Codex Account Inspection**
  - Operational inspection and cleanup workflow for Codex auth pools
- **Usage**
  - Usage charts, API and model breakdowns, cached/reasoning token views, exports/imports, and local model pricing for cost estimation
- **Logs**
  - Incremental log tailing, auto refresh, search, hiding management traffic, clearing logs, and request error-log download
- **System**
  - Quick links, local state utilities, and grouped `/v1/models` browsing

## Operational notes

- Request Monitoring depends on `/usage` data. If usage statistics are disabled on the backend, the page can only show limited connection and config state.
- The Logs navigation item appears only when file logging is enabled.
- Some auth-file features depend on backend support, especially model-list, excluded-model, and status-shape variations.
- Codex Account Inspection can mutate auth files by deleting, disabling, or enabling entries. Review suggested actions before executing them.

## Tech stack

- React 19 + TypeScript 5.9
- Vite 7 with single-file output
- Zustand
- Axios
- react-router-dom v7
- Chart.js
- CodeMirror 6
- SCSS Modules
- i18next

## Internationalization

Currently supports four languages:

- English (`en`)
- Simplified Chinese (`zh-CN`)
- Traditional Chinese (`zh-TW`)
- Russian (`ru`)

The UI language is auto-detected from the browser and can also be switched manually in the UI.

## Browser compatibility

- Build target: `ES2020`
- Supports modern Chrome, Firefox, Safari, and Edge
- Responsive layout for desktop, tablet, and mobile access

## Build and release notes

- Vite produces a single inlined HTML file at `dist/index.html`
- `vite-plugin-singlefile` is used to inline assets
- Tagging `vX.Y.Z` triggers `.github/workflows/release.yml` to publish `dist/management.html`
- The UI version shown in the footer is injected at build time from `VERSION`, git tags, or `package.json`

## Security notes

- The management key is stored in browser `localStorage` using a lightweight obfuscation format (`enc::v1::...`), but it should still be treated as sensitive.
- Request Monitoring and inspection pages may surface account labels, endpoints, models, and usage data. Use the UI only on trusted devices and browser profiles.
- Be cautious when enabling remote management or executing destructive auth-file actions.

## Troubleshooting

- **Cannot connect / 401**: verify the API address and management key. Remote access may also require enabling remote management server-side.
- **Monitoring page looks empty**: enable usage statistics in the backend config. Without `/usage`, runtime analytics stay limited.
- **Codex inspection results are incomplete**: verify that the target auth files expose usable `auth_index` metadata and that the backend accepts management-side probe requests.
- **Logs page is missing**: enable file logging in configuration first.
- **Some features show unsupported behavior**: the backend may be older, the endpoint may be absent, or metadata may be returned in a different shape.
- **OpenAI provider browser test fails**: that test runs in the browser and is affected by network and CORS. Failure there does not always mean the backend cannot reach the provider.

## Development

```bash
npm run dev        # Vite dev server
npm run build      # tsc + Vite build
npm run preview    # Preview dist locally
npm run lint       # ESLint
npm run format     # Prettier for src/*
npm run type-check # tsc --noEmit
```

## Contributing

Issues and PRs are welcome. Include:

- Reproduction steps
- Backend version and UI version
- Screenshots for UI changes
- Verification notes such as `npm run lint` and `npm run type-check`

## License

MIT
