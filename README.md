# calendar-mcp

A thin, local MCP server that lets agents read and manage calendars across **Nextcloud** (e.g. thegood.cloud), **iCloud** and **Google**, all over CalDAV.

The simplest one you can make. Have your agent a field day in this repo

## Install

```sh
git clone <this repo> calendar-mcp && cd calendar-mcp
npm install && npm run build
npm link            # optional: puts `calendar-mcp` on your PATH
calendar-mcp init   # writes ~/.config/calendar-mcp/config.toml
```

Requires Node 20+.

## Set up accounts

Edit `~/.config/calendar-mcp/config.toml` (or point `CALENDAR_MCP_CONFIG` elsewhere). Each secret is a reference:

| Reference | Resolves to |
|---|---|
| `keychain:service/account` | macOS Keychain item. Store with `security add-generic-password -s service -a account -w` (it prompts for the value) |
| `env:NAME` | environment variable |
| `cmd:op read op://Private/iCloud/password` | stdout of any command (1Password, `pass`, `secret-tool`, …) |

### thegood.cloud / Nextcloud
1. Nextcloud → **Settings → Security → Devices & sessions → Create new app password**.
2. `security add-generic-password -s calendar-mcp -a thegood -w`
```toml
[[accounts]]
id = "thegood"
provider = "nextcloud"
url = "https://your.next.cloud/remote.php/dav"
username = "your-login"
password = "keychain:calendar-mcp/thegood"
```

### iCloud
1. [account.apple.com](https://account.apple.com) → **Sign-In and Security → App-Specific Passwords**.
2. `security add-generic-password -s calendar-mcp -a icloud -w`
```toml
[[accounts]]
id = "icloud"
provider = "icloud"
username = "you@icloud.com"
password = "keychain:calendar-mcp/icloud"
```

### Google
Google only allows OAuth for CalDAV, so it needs a one-time setup:
1. [Google Cloud Console](https://console.cloud.google.com): create a project and enable the **CalDAV API**.
2. **OAuth consent screen**: choose External and add yourself as a test user. Then set the publishing status to **In production**, because tokens issued in "Testing" mode expire after 7 days. You'll see an "unverified app" warning when you sign in. That's expected for a personal app.
3. **Credentials → Create OAuth client ID → Desktop app.** Put the client ID in the config and store the secret: `security add-generic-password -s calendar-mcp -a google-client-secret -w`
4. `calendar-mcp auth google --account google` opens your browser and stores the refresh token in the Keychain.
```toml
[[accounts]]
id = "google"
provider = "google"
username = "you@gmail.com"
client_id = "xxxx.apps.googleusercontent.com"
client_secret = "keychain:calendar-mcp/google-client-secret"
refresh_token = "keychain:calendar-mcp/google"
```

### Verify
```sh
calendar-mcp check
✓ thegood (nextcloud) — 2 calendar(s)
    thegood/personal                 Personal
✓ icloud (icloud) — 3 calendar(s)
    ...
```

## Connect an agent

**Claude Code**
```sh
claude mcp add calendar -s user -- calendar-mcp
# or without npm link:
claude mcp add calendar -s user -- node /absolute/path/to/calendar-mcp/dist/index.js
```

**Claude Desktop / Cursor / others.** Add this to the client's MCP config. GUI apps often have a minimal PATH, so use absolute paths:
```json
{
  "mcpServers": {
    "calendar": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/calendar-mcp/dist/index.js"]
    }
  }
}
```

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

## Development

```sh
npm run build && npm test
npx @modelcontextprotocol/inspector node dist/index.js   # poke at tools by hand
```

Layout: `src/config.ts` and `src/secrets.ts` hold config and secret handling shared across modules. `src/calendar/` contains `dav.ts` (CalDAV), `ical.ts` (parsing, recurrence, writing), `time.ts` (timezones) and `tools.ts` (MCP tools). Mail and files will be added as sibling modules.
