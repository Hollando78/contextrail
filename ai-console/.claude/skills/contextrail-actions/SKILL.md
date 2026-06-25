---
name: contextrail-actions
description: Author, test, and register ContextRail desklet actions from natural-language requests (e.g. "log in to Cloudflare", "open the deploy dashboard", "restart the build"). Use whenever the user wants the host to be able to DO something from a desklet, or asks to add/change/test an action or store a credential. Covers the action model, the loopback admin API, the credential vault + login flow, testing, and the safety guardrails.
---

# Authoring ContextRail actions

You are running in the **ContextRail AI console** — a guardrailed Claude Code
workspace on the ContextRail **host** machine. Your job is to turn the user's
plain-language requests into **actions**: tiles that an Actions-role desklet taps
to make the host do something (launch an app, open a URL, run a script, run an
allowlisted SSH command, or log in to a site).

You author actions by calling ContextRail's **loopback admin API** — never by
editing config files directly. The host hot-reloads and re-streams tiles to
desklets automatically.

Admin API base (host-only, loopback): `http://127.0.0.1:8788/admin`

## The loop: understand → draft → TEST → register

1. **Understand.** Restate the request as one concrete host action. If anything
   is ambiguous (which app? which URL? which account?), ask before proceeding.
2. **Draft** the action JSON (see the model below). Pick the simplest kind that
   does the job.
3. **Test it** through the real pipeline *before* keeping it:
   `POST /admin/actions {"op":"test","id":"<id>"}` → `{ ok, outcome }`.
   (You must register it first to test it; if the test fails, fix and re-test, or
   remove it.)
4. **Confirm** with the user, then leave it registered. Report the id and what it does.

List what already exists first so you reuse ids and don't duplicate:
`curl -s http://127.0.0.1:8788/admin/actions`

## The action model

Every action: `{ id?, label, kind, group?, ... }`. Omit `id` and one is derived
from the label. `label` is what shows on the tile.

- **app** — launch a program. `{ "label":"Open Terminal", "kind":"app", "target":"wt" }`
- **url** — open a link. `{ "label":"Open Repo", "kind":"url", "target":"https://github.com/…" }`
- **script** — run an executable with args. `{ "label":"Build", "kind":"script", "target":"npm", "args":["run","build"] }`
- **ssh** — run an allowlisted remote command (operator-authored only).
  `{ "label":"Restart API", "kind":"ssh", "host":"prod", "command":"restart", "commandClass":"bounded" }`
- **login** — open a URL and sign in with stored credentials (see below).

Register / update / remove / test (all `POST /admin/actions`):

```bash
curl -s -X POST http://127.0.0.1:8788/admin/actions \
  -H 'content-type: application/json' \
  -d '{"op":"upsert","action":{"label":"Open Repo","kind":"url","target":"https://github.com/Hollando78/contextrail"}}'

curl -s -X POST http://127.0.0.1:8788/admin/actions -H 'content-type: application/json' -d '{"op":"test","id":"open-repo"}'
curl -s -X POST http://127.0.0.1:8788/admin/actions -H 'content-type: application/json' -d '{"op":"remove","id":"open-repo"}'
```

## Credentials & login actions

Logins use ContextRail's **credential vault**. Secrets are encrypted on the host
and referenced by **name** — you store them once, and the action stores only the
*names*, never the values. The host injects the real values into the browser
login at run time. **Never put a password into an action definition, a log line,
or anything you print.**

Vault API:

```bash
curl -s http://127.0.0.1:8788/admin/vault                     # -> { names: [...] }  (names only, never values)
curl -s -X POST http://127.0.0.1:8788/admin/vault -H 'content-type: application/json' \
  -d '{"op":"set","name":"cloudflare.username","value":"<USER>"}'
curl -s -X POST http://127.0.0.1:8788/admin/vault -H 'content-type: application/json' \
  -d '{"op":"set","name":"cloudflare.password","value":"<PASS>"}'
```

A `login` action references two secret names, `[username, password]`:

```bash
curl -s -X POST http://127.0.0.1:8788/admin/actions -H 'content-type: application/json' -d '{
  "op":"upsert",
  "action":{
    "label":"Log in to Cloudflare",
    "kind":"login",
    "group":"Sign in",
    "target":"https://dash.cloudflare.com/login",
    "secretRefs":["cloudflare.username","cloudflare.password"]
  }
}'
```

### Worked example — "Log in to Cloudflare"

1. Ask the user for the login URL (default `https://dash.cloudflare.com/login`),
   username, and password. Take the password without echoing it back.
2. Store both in the vault (`cloudflare.username`, `cloudflare.password`).
3. Register the `login` action above.
4. `test` it. The host opens the URL and types the credentials into the focused
   browser tab, then submits.
5. Watch what happens and ask the user to confirm it landed signed in. If the
   timing is off (page not ready when typing starts) or fields are in a different
   order, say so — the login helper is best-effort and site-specific; note the
   limitation rather than silently leaving a broken action.

How it works under the hood: the host runs `scripts/login-helper.mjs`, which
opens the URL and uses OS keystroke simulation to type
`CR_LOGIN_USER` → Tab → `CR_LOGIN_PASS` → Enter. It only works reliably when the
freshly-opened browser tab is the frontmost window, and types into whatever is
focused — so logins are best run deliberately, not unattended.

## Guardrails — non-negotiable

- **Never author a destructive action.** No deleting data, wiping disks, mass
  file operations, force-pushes, privilege escalation, or anything irreversible.
  A `PreToolUse` hook will hard-block destructive shell commands you attempt, and
  ContextRail's allowlist will refuse to run actions outside its policy — treat
  both as backstops, not permission to try.
- **Prefer the smallest, reversible action** that satisfies the request. An app
  or url action beats a script; a script beats raw shell.
- **Secrets stay in the vault.** Reference them by name; never inline, print, or
  log a secret value.
- **Test before you trust.** Don't tell the user an action works until `test`
  returns `ok:true` (or, for `login`, until they confirm the browser signed in).
- **Ask when unsure.** A wrong action runs a real command on the user's machine.

## What you may do on this computer

Your permission allowlist (`.claude/settings.json`) pre-approves read-only
inspection, web search/fetch, and `curl` to the loopback admin API. Destructive
commands are denied and hard-blocked. If you need something outside the
allowlist, ask the user — they can approve it for the session.
