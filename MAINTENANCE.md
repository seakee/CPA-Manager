# Fork Maintenance Guide

This fork of [seakee/CPA-Manager](https://github.com/seakee/CPA-Manager) is maintained as a long-lived custom build that tracks upstream while carrying local changes.

## Branch Strategy

| Branch | Purpose | Source of truth |
| --- | --- | --- |
| `main` | Mirror of `upstream/main`. Do **not** commit custom changes here. | `upstream/main` |
| `custom` | Long-lived integration branch carrying all custom changes. Triggers Docker Hub publish. | local |
| `feature/*` | Short-lived branches for individual changes; PR into `custom`. | local |

Rule of thumb: `main` should always be a fast-forward of `upstream/main`. All custom commits live on `custom` (or branches merged into it).

## Remotes

```
origin    → your fork (push target for main, custom, feature/*)
upstream  → https://github.com/seakee/CPA-Manager.git (fetch only)
```

Verify:

```bash
git remote -v
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/seakee/CPA-Manager.git
```

> Never `git push upstream` — it will be rejected, but it is also a footgun. Only `git fetch upstream`.

## Sync Workflow (default: merge)

Run this whenever upstream has new commits you want to pick up.

```bash
# 1. Update main to match upstream exactly
git checkout main
git fetch upstream
git reset --hard upstream/main
git push origin main --force-with-lease

# 2. Bring upstream changes into custom
git checkout custom
git merge main
# resolve conflicts if any, then:
git push origin custom
```

`--force-with-lease` is safer than `--force`: it refuses to push if `origin/main` was updated by someone else in the meantime.

### Why merge instead of rebase

Merging keeps `custom` history honest — every upstream sync is one merge commit, easy to revert with `git revert -m 1 <merge-sha>`. Rebase rewrites your customs on top of upstream, which produces a cleaner log but breaks any open feature branches and makes rollback messy. Use rebase only when `custom` has zero published descendants.

## Adding a Custom Change

```bash
git checkout custom
git pull origin custom
git checkout -b feature/short-description
# ... edit, commit ...
git push -u origin feature/short-description
# open PR: feature/short-description → custom
```

Once merged into `custom`, the Docker workflow will publish a new image automatically.

## Docker Image

- **Image:** [`nnnmdzz2/cpa-manager`](https://hub.docker.com/r/nnnmdzz2/cpa-manager)
- **Architectures:** `linux/amd64`, `linux/arm64`
- **Built from:** [`Dockerfile.usage-service`](./Dockerfile.usage-service)

### Tags published per push

| Tag | Meaning |
| --- | --- |
| `latest` | Most recent successful build from `custom` |
| `custom` | Same as `latest`, named for clarity |
| `<git-sha>` | Immutable pin to a specific commit |

### Publish triggers

- Automatic: every push to `custom` (after frontend + Go tests pass)
- Manual: GitHub → Actions → **Build and Push Docker Image** → **Run workflow**

### Required GitHub Secrets

Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | Your Docker Hub login (e.g. `nnnmdzz2`) |
| `DOCKERHUB_TOKEN` | Docker Hub access token with **Read, Write, Delete** scope on the `cpa-manager` repo. Create at https://hub.docker.com/settings/security |

The workflow validates both secrets exist before attempting login. Docker tokens are passed via `docker/login-action`, which masks them in logs — never `echo` them yourself.

### Run / pull the image

```bash
# Pull latest
docker pull nnnmdzz2/cpa-manager:latest

# Run
docker run -d --name cpa-manager \
  -p 18317:18317 \
  -v cpa-manager-data:/data \
  nnnmdzz2/cpa-manager:latest

# Pin to a specific build
docker pull nnnmdzz2/cpa-manager:<git-sha>
```

For docker-compose, change the `image:` line in `docker-compose.usage.yml` from `seakee/cpa-manager:latest` to `nnnmdzz2/cpa-manager:latest`.

### Local manual build

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f Dockerfile.usage-service \
  -t nnnmdzz2/cpa-manager:dev \
  --build-arg VERSION=dev-local \
  .
```

## Rollback Playbook

### Roll back the latest Docker image

```bash
# Find the previous good SHA in GitHub Actions history, then:
docker pull nnnmdzz2/cpa-manager:<previous-sha>
docker tag nnnmdzz2/cpa-manager:<previous-sha> nnnmdzz2/cpa-manager:latest
docker push nnnmdzz2/cpa-manager:latest
```

### Revert a bad upstream merge

```bash
git checkout custom
git revert -m 1 <merge-commit-sha>
git push origin custom
```

### Reset `custom` to a known good commit (destructive)

```bash
git checkout custom
git reset --hard <good-sha>
git push origin custom --force-with-lease
```

Use only when you accept losing the intermediate commits. Coordinate with anyone who has the branch checked out.

## Risk Notes

- `git reset --hard upstream/main` on `main` will discard anything committed to `main` locally. Only run after confirming `git diff upstream/main..main` is empty (or you don't care about it).
- Force-pushing `main` via `--force-with-lease` is normal for this workflow because `main` is treated as a mirror, not a working branch.
- Conflicts during `git merge main` into `custom` are expected when upstream touches files you've customized. Resolve them in `custom` — never edit `main`.
