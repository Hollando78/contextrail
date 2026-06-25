# ContextRail AI Console

A guardrailed [Claude Code](https://claude.com/claude-code) workspace for
authoring ContextRail actions in plain language.

Launch it from the Host Console ("Launch AI Console"), or manually:

```bash
cd ai-console
claude
```

Then describe what you want the host to be able to do — for example:

> Add an action that logs me in to Cloudflare.
> Add a tile that opens the deploy dashboard.
> Make a "Restart API" action over SSH to prod.

Claude (loaded with the `contextrail-actions` skill) will draft the action, test
it through ContextRail's real allowlist + guardrails, and register it so the tile
appears on your Actions desklet. Credentials go into ContextRail's encrypted
vault and are referenced by name — never stored in the action.

## Safety

- `.claude/settings.json` pre-approves only read-only inspection, web
  search/fetch, and `curl` to the loopback admin API; destructive commands are
  denied.
- `.claude/hooks/guardrail.mjs` is a `PreToolUse` hook that hard-blocks
  destructive shell commands (delete, format, force-push, privilege escalation…)
  regardless of the allowlist.
- Actions still pass through ContextRail's allowlist (ACG) when they run.

This directory and its `.claude/` config are committed; nothing secret lives
here. Credentials live encrypted under `data/` on the host.
