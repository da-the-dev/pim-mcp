# Contributing

Thanks for helping. This project aims to stay **thin**: a small codebase, few dependencies, a local stdio server, and tools an agent can use without reading docs. Please keep changes in that spirit.

## Dev setup

```sh
git clone https://github.com/da-the-dev/pim-mcp && cd pim-mcp
npm install        # builds dist/ via the prepare script
npm link           # optional: puts your dev build on PATH as `pim-mcp`
npm test           # unit tests (vitest)
npm run dev        # tsc --watch
npx @modelcontextprotocol/inspector node dist/index.js   # call tools by hand
```

### Testing against a real CalDAV server without your own accounts

[Radicale](https://radicale.org) runs a throwaway CalDAV server in one command:

```sh
mkdir -p /tmp/radicale && cat > /tmp/radicale/config <<'EOF'
[server]
hosts = 127.0.0.1:5232
[auth]
type = none
[storage]
filesystem_folder = /tmp/radicale/data
EOF
uvx radicale --config /tmp/radicale/config     # or: pip install radicale && python -m radicale --config …

# create a calendar
curl -u tester:x -X MKCALENDAR http://127.0.0.1:5232/tester/work/ \
  -H 'Content-Type: application/xml' \
  --data '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Work</D:displayname></D:prop></D:set></C:mkcalendar>'
```

Then point a test config at it:

```toml
[[accounts]]
id = "local"
provider = "caldav"
url = "http://127.0.0.1:5232/"
username = "tester"
password = "env:RADICALE_PW"   # any value works with auth = none
```

```sh
RADICALE_PW=x PIM_MCP_CONFIG=./test-config.toml node dist/index.js check
```

## Code map

| File | Role |
|---|---|
| `src/index.ts` | CLI: `serve` (default), `init`, `check`, `secret set`, `auth google` |
| `src/config.ts` | TOML config schema (zod) |
| `src/secrets.ts` | `env:` / `keychain:` / `cmd:` refs; per-OS secret stores |
| `src/providers.ts` | provider presets (server URLs, OAuth endpoints) |
| `src/calendar/dav.ts` | `CalendarStore`: account connections, calendar discovery, fetch/create/update/delete over CalDAV |
| `src/calendar/ical.ts` | iCalendar parsing, recurrence expansion, writing/patching events |
| `src/calendar/time.ts` | timezone math on top of `Intl` |
| `src/calendar/tools.ts` | MCP tool definitions and guardrails |

## Adding a CalDAV provider preset

If a provider speaks CalDAV, it already works through `provider = "caldav"`. A preset only saves users from looking up the URL:

1. Add the name to the `provider` enum in `src/config.ts`.
2. Add its URL to `PRESET_URLS` in `src/providers.ts`, and note its auth method (app password? OAuth?).
3. Add a setup section and a row in the README's Providers table.
4. Check it against a real account with `pim-mcp check`, plus a create, update and delete through the inspector, and say in the PR which account type you tested.

Confirming one of the README's "should work" providers is just as useful: open a PR that updates the table.

## Adding a non-CalDAV backend (e.g. Outlook)

Outlook.com, Microsoft 365 and Exchange don't support CalDAV; they need the [Microsoft Graph calendar API](https://learn.microsoft.com/graph/api/resources/calendar). This is the biggest missing piece and help is welcome. Expect it to be a substantial change, not a preset:

- Today `tools.ts` talks to `CalendarStore` (`dav.ts`), which exchanges raw iCalendar text that `ical.ts` parses and writes. Graph returns JSON events, not iCalendar.
- The cleanest path is probably to introduce a small `CalendarBackend` interface: list calendars, list occurrences in a range, get, create, update, and delete. The occurrences would come back already normalized. CalDAV would implement it with the existing `dav.ts` + `ical.ts`, and Graph with `calendarView` (which expands recurrences server-side) and its own field mapping.
- Auth would mirror the Google flow: a `pim-mcp auth microsoft` command doing the OAuth loopback with PKCE, storing the refresh token through `storeKeychain`.

Please **open an issue first** to agree on the interface before writing a lot of code.

## Releasing (maintainers)

1. Bump `version` in `package.json` **and** both `version` fields in `server.json`.
2. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.

The `Release` workflow runs the full test matrix, then publishes to npm (trusted publishing, with provenance) and to the MCP Registry. It refuses to run if the tag and versions disagree.

## Guidelines

- **Guardrails stay off by default.** Anything that deletes data or emails other people must sit behind a config flag. Refusals should name the flag.
- **Never log or print secrets**, including in error messages.
- **Tool output is for agents.** Keep it compact, predictable JSON, and keep names and descriptions self-explanatory.
- **Tests.** Changes to `ical.ts` or `time.ts` need tests in `test/`. Recurrence, all-day and DST edge cases are where bugs hide.
- **Cross-platform.** Code must run on macOS, Linux and Windows. Don't assume `/bin/sh`, `~` expansion, or `/` path separators. Use `node:path` and `node:os`.
- **Dependencies.** Avoid new runtime dependencies unless they remove real complexity.
