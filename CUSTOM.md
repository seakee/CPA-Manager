# Customizations

## Custom quota display limit

- Scope: `src/pages/QuotaPage.tsx`, `src/components/quota/QuotaSection.tsx`
- Purpose: Replace the hardcoded `MAX_SHOW_ALL_THRESHOLD` behavior with configurable `custom.quota.displayLimitCount` so more than 30 credentials can use “show all” when configured.
- Configuration: `custom.quota.displayLimitCount`, default `30` when missing or invalid.
- Upstream contribution: Possibly, if upstream accepts a generic configurable quota display threshold; current config path is fork-specific.

## Custom project rules

- Scope: `.claude/rules.md`, `CUSTOM.md`
- Purpose: Document branch workflow, custom release conventions, low-intrusion custom code rules, and PR audit requirements for this fork.
- Upstream contribution: No. This is fork-specific process documentation.
