# pim-mcp

[![npm](https://img.shields.io/npm/v/pim-mcp)](https://www.npmjs.com/package/pim-mcp) [![CI](https://github.com/da-the-dev/pim-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/da-the-dev/pim-mcp/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A thin, local MCP server that lets agents read and manage your calendars across **Nextcloud** (e.g. thegood.cloud), **iCloud**, **Google**, and any other CalDAV server. Runs on macOS, Linux and Windows.

- **One merged view.** `list_events` returns every calendar on every account, sorted, with recurring events expanded.
- **Portable.** One TOML config with no secrets in it. The same file works on every OS, because secrets are references to your OS secret store, env vars, or a password-manager command.
- **Local and on-demand.** Your agent client starts it over stdio. Nothing runs in the background and there's no network listener.
- **Guardrails.** Deleting events and anything that emails attendees are off until you turn them on.

## Install

Requires [Node.js](https://nodejs.org) 22 or newer.

```sh
npm install -g pim-mcp
pim-mcp init         # writes a config template
```

Prefer not to install globally? Prefix each command with `npx -y`, e.g. `npx -y pim-mcp init`. To build from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

The config lives at `~/.config/pim-mcp/config.toml` on every OS. On Windows that's `C:\Users\<you>\.config\pim-mcp\config.toml`. To use a different location, set `PIM_MCP_CONFIG`.

## Store secrets

Passwords and tokens never go in the config. The config holds a **reference** instead:

| Reference | Resolves to |
|---|---|
| `keychain:service/account` | your OS secret store (see below) |
| `env:NAME` | an environment variable |
| `cmd:<command>` | the output of a command, e.g. `cmd:op read op://Private/iCloud/password` (1Password), `cmd:pass show icloud`, `cmd:bw get password icloud` |

The simplest way is `keychain:` with the built-in command, which prompts for the secret without echoing it:

```sh
pim-mcp secret set pim-mcp/icloud
```

Where `keychain:` secrets are stored on each OS:

<details open>
<summary><b>macOS</b></summary>

The login **Keychain**. You can also manage items with Keychain Access or `security add-generic-password -s pim-mcp -a icloud -w`.
</details>

<details>
<summary><b>Linux</b></summary>

The desktop keyring (GNOME Keyring or KWallet) via the Secret Service API. This needs `secret-tool`:

```sh
sudo apt install libsecret-tools     # Debian/Ubuntu
sudo dnf install libsecret           # Fedora
sudo pacman -S libsecret             # Arch
```

On a **headless machine or server** there's usually no keyring running. Use `env:` refs (set the variables in your MCP client config) or `cmd:` with [`pass`](https://www.passwordstore.org/) instead:
```toml
password = "cmd:pass show pim-mcp/icloud"
```
</details>

<details>
<summary><b>Windows</b></summary>

Secrets are encrypted with **DPAPI**, the Windows per-user encryption that Credential Manager also uses. They're stored under `%APPDATA%\pim-mcp\secrets\` and only your Windows user on this machine can decrypt them. Nothing extra to install, since PowerShell ships with Windows.

`cmd:` refs run in `cmd.exe`, e.g. `cmd:op read op://Private/iCloud/password`.
</details>

## Set up accounts

### thegood.cloud / Nextcloud
1. Nextcloud → **Settings → Security → Devices & sessions → Create new app password**.
2. `pim-mcp secret set pim-mcp/thegood`
```toml
[[accounts]]
id = "thegood"
provider = "nextcloud"
url = "https://use08.thegood.cloud/remote.php/dav"
username = "your-login"
password = "keychain:pim-mcp/thegood"
```

### iCloud
1. [account.apple.com](https://account.apple.com) → **Sign-In and Security → App-Specific Passwords**.
2. `pim-mcp secret set pim-mcp/icloud`
```toml
[[accounts]]
id = "icloud"
provider = "icloud"
username = "you@icloud.com"    # the email you sign into your Apple Account with
password = "keychain:pim-mcp/icloud"
```

### Google
Google only allows OAuth for CalDAV, so it needs a one-time setup:
1. [Google Cloud Console](https://console.cloud.google.com): create a project and enable the **CalDAV API**.
2. **OAuth consent screen**: choose External and add yourself as a test user. Then set the publishing status to **In production**, because tokens issued in "Testing" mode expire after 7 days. You'll see an "unverified app" warning when you sign in. That's expected for a personal app.
3. **Credentials → Create OAuth client ID → Desktop app.** Put the client ID in the config, then store the secret with `pim-mcp secret set pim-mcp/google-client-secret`.
4. `pim-mcp auth google --account google` opens your browser and stores the refresh token in your OS secret store.
```toml
[[accounts]]
id = "google"
provider = "google"
username = "you@gmail.com"
client_id = "xxxx.apps.googleusercontent.com"
client_secret = "keychain:pim-mcp/google-client-secret"
refresh_token = "keychain:pim-mcp/google"
```

### Any other CalDAV server
```toml
[[accounts]]
id = "fastmail"
provider = "caldav"
url = "https://caldav.fastmail.com/"
username = "you@fastmail.com"
password = "keychain:pim-mcp/fastmail"
```
See [Providers](#providers) for known URLs.

### Verify
```sh
pim-mcp check
✓ thegood (nextcloud) — 2 calendar(s)
    thegood/personal                 Personal
✓ icloud (icloud) — 3 calendar(s)
    ...
```

## Connect an agent

**Claude Code** (all platforms)
```sh
claude mcp add pim -s user -- npx -y pim-mcp
```

**Claude Desktop, Cursor and other GUI clients.** Add the server to the client's MCP config:

<details open>
<summary><b>macOS</b>: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "pim": {
      "command": "npx",
      "args": ["-y", "pim-mcp"]
    }
  }
}
```
GUI apps don't always see your shell's PATH. If the server fails to start, replace `npx` with its full path from `which npx`, e.g. `/opt/homebrew/bin/npx`.
</details>

<details>
<summary><b>Windows</b>: <code>%APPDATA%\Claude\claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "pim": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "pim-mcp"]
    }
  }
}
```
`npx` is a batch script on Windows, so it runs through `cmd /c`.
</details>

<details>
<summary><b>Linux</b></summary>

Claude Desktop isn't available for Linux; use Claude Code or another MCP client with the same `command` / `args` as macOS. If you use `env:` refs, put the variables in the client's `env` block:
```json
"pim": {
  "command": "npx",
  "args": ["-y", "pim-mcp"],
  "env": { "ICLOUD_PASSWORD": "…" }
}
```
</details>

## Tools

| Tool | What it does |
|---|---|
| `list_calendars` | All calendars and their ids (`icloud/work`). Anywhere a tool takes a calendar, you can also use its plain name. |
| `list_events` | Events from all calendars in a range, merged and sorted. Defaults to today through the next 7 days. |
| `search_events` | Text search over title, location and description. |
| `get_event` | Full details: description, attendees, organizer, recurrence rule. |
| `find_free_time` | Free windows of at least N minutes, optionally limited to working hours. |
| `create_event` | Timed or all-day, with recurrence, a reminder, and busy/free status. |
| `update_event` | Changes only the fields you pass. For recurring events, `scope` is `instance` or `series`. |
| `delete_event` | Off unless `allow_delete = true`. |

Conventions agents see:
- Times without an offset are in the configured `timezone` (default: the system timezone).
- Output is ISO 8601 with offsets.
- All-day events use `YYYY-MM-DD`, and their end date is inclusive.

## Guardrails & options

```toml
timezone = "Europe/Amsterdam"
[guardrails]
allow_delete = false     # delete_event refused
allow_invites = false    # refuse adding attendees, or editing/deleting events that have attendees (servers email them)

[[accounts]]
# ...
read_only = true                         # no writes to this account at all
read_only_calendars = ["Family"]         # protect specific calendars
hide_calendars = ["Birthdays"]           # don't show these at all
```

When a guardrail refuses an action, the agent gets an error naming the setting that would allow it, so it can tell you instead of retrying.

Writes check the event's ETag. If the event changed elsewhere since it was read, the write fails rather than overwriting that change.

## Providers

| Provider | Status | Notes |
|---|---|---|
| Nextcloud / ownCloud (thegood.cloud, …) | ✅ `nextcloud` | `https://<host>/remote.php/dav` |
| iCloud | ✅ `icloud` | app-specific password |
| Google Calendar | ✅ `google` | OAuth, see setup above |
| Fastmail | should work: `caldav` | `https://caldav.fastmail.com/`, app password |
| Yahoo | should work: `caldav` | `https://caldav.calendar.yahoo.com`, app password |
| mailbox.org | should work: `caldav` | `https://dav.mailbox.org/` |
| Posteo | should work: `caldav` | `https://posteo.de:8443/` |
| Self-hosted (Radicale, Baïkal, SOGo, Synology, …) | should work: `caldav` | your server's DAV URL |
| Outlook.com / Microsoft 365 / Exchange | ❌ not yet | no CalDAV; needs a Microsoft Graph backend ([help wanted](CONTRIBUTING.md#adding-a-non-caldav-backend-eg-outlook)) |
| Proton Calendar | ❌ | no CalDAV or public API |

"Should work" means standard CalDAV that no one has confirmed with this project yet. If you've tried one, please open a PR updating this table.

## Contributing & license

MIT licensed. New providers, fixes and confirmations of the "should work" entries are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
