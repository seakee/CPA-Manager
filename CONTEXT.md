# CPA-Manager Fork Context

This context defines the product language for a CPA-Manager fork that selectively absorbs LTS quota capabilities.

## Language

**CPA-Manager Fork**:
The product line based on seakee/CPA-Manager that receives selected capabilities from CPA Panel LTS.
_Avoid_: CPA Panel LTS, ordinary upstream panel

**CPA Panel LTS**:
The source product line for selected quota capabilities that should be ported into the CPA-Manager Fork.
_Avoid_: target product, replacement manager

**Usage Service**:
The companion CPA-Manager service that owns persistent request usage for newer CPA deployments.
_Avoid_: optional stats add-on, replacement CPA runtime

**Weekly Quota Estimate**:
The Codex quota capability that estimates or prioritizes weekly quota limits when presenting account usage.
_Avoid_: generic quota display, daily-only usage

**Single Credential Refresh**:
The quota interaction that refreshes one credential without forcing a full credential-list refresh.
_Avoid_: global refresh, bulk refresh

## Relationships

- **CPA-Manager Fork** is based on CPA-Manager, not on **CPA Panel LTS**.
- **CPA-Manager Fork** uses **Usage Service** for persistent request usage in newer CPA deployments.
- **CPA Panel LTS** supplies **Weekly Quota Estimate** and **Single Credential Refresh** behavior to the **CPA-Manager Fork**.
- **Single Credential Refresh** applies to one credential at a time.

## Example dialogue

> **Dev:** "Are we merging CPA-Manager into the LTS panel?"
> **Domain expert:** "No. We are forking CPA-Manager and porting the LTS weekly quota estimate plus single credential refresh into it."

## Flagged ambiguities

- "Fuse CPA-Manager" was used ambiguously; resolved: the target is a **CPA-Manager Fork**, and **CPA Panel LTS** is only a source for selected quota capabilities.
- "Built-in statistics" was used ambiguously; resolved: newer CPA deployments rely on **Usage Service** for persistent request usage.
