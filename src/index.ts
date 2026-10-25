#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { CalendarStore } from './calendar/dav.js';
import { registerCalendarTools } from './calendar/tools.js';
import { configPath, loadConfig, type Config } from './config.js';
import { GOOGLE_AUTH_URL, GOOGLE_SCOPE, GOOGLE_TOKEN_URL } from './providers.js';
import { resolveSecret, secretKind, storeKeychain } from './secrets.js';

const VERSION = '0.1.0';

const EXAMPLE_CONFIG = `# calendar-mcp config. Secrets are references, never literal values:
#   env:NAME | keychain:service/account (macOS) | cmd:<command printing the secret>
# Store a Keychain secret:  security add-generic-password -s calendar-mcp -a <account-id> -w

# timezone = "Europe/Amsterdam"   # default: this machine's timezone

[guardrails]
allow_delete = false    # let agents delete events
allow_invites = false   # let agents add/change attendees (servers email invitations)

[[accounts]]
id = "thegood"
provider = "nextcloud"
url = "https://use08.thegood.cloud/remote.php/dav"
username = "you@example.com"
password = "keychain:calendar-mcp/thegood"   # Nextcloud: Settings → Security → app password

[[accounts]]
id = "icloud"
provider = "icloud"
username = "you@icloud.com"
password = "keychain:calendar-mcp/icloud"    # appleid.apple.com → App-Specific Passwords
# hide_calendars = ["Reminders"]

[[accounts]]
id = "google"
provider = "google"
username = "you@gmail.com"
client_id = "xxxx.apps.googleusercontent.com" # Google Cloud Console → OAuth client (Desktop app)
client_secret = "keychain:calendar-mcp/google-client-secret"
refresh_token = "keychain:calendar-mcp/google" # filled in by: calendar-mcp auth google --account google
# read_only_calendars = ["Holidays in Netherlands"]
`;

const HELP = `calendar-mcp ${VERSION} — local MCP server for CalDAV calendars

Usage:
  calendar-mcp                      run the MCP server on stdio (what your agent client starts)
  calendar-mcp init                 write an example config to ${configPath()}
  calendar-mcp check                connect to every account and list its calendars
  calendar-mcp auth google --account <id>
                                    one-time browser login for a Google account

Config: ${configPath()} (override with CALENDAR_MCP_CONFIG)`;

async function serve() {
  let ctx: { store: CalendarStore; config: Config } | undefined;
  let configError: Error | undefined;
  try {
    const config = loadConfig();
    ctx = { config, store: new CalendarStore(config) };
  } catch (e) {
    configError = e as Error; // surface through tool errors so the agent can tell the user
  }
  const tz = ctx?.config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const server = new McpServer(
    { name: 'calendar-mcp', version: VERSION },
    {
      instructions: [
        `Calendars from the user's configured accounts (${ctx?.config.accounts.map((a) => a.id).join(', ') ?? 'not configured'}).`,
        `Times without an offset are in ${tz}; results use ISO 8601 with offsets. All-day events use YYYY-MM-DD and their end date is inclusive.`,
        'Start with list_events or list_calendars. Event ids come from list/search results. For recurring events, update/delete need scope "instance" or "series".',
        'If a write is refused by a guardrail, tell the user which config setting would allow it instead of retrying.',
      ].join('\n'),
    },
  );
  registerCalendarTools(server, () => {
    if (!ctx) throw configError!;
    return ctx;
  });
  await server.connect(new StdioServerTransport());
}

function init() {
  const path = configPath();
  if (existsSync(path)) {
    console.log(`Config already exists at ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, EXAMPLE_CONFIG, { mode: 0o600 });
  console.log(`Wrote example config to ${path}\nEdit it, store your secrets, then run: calendar-mcp check`);
}

async function check() {
  const config = loadConfig();
  console.log(`Config: ${configPath()}\nTimezone: ${config.timezone}\n`);
  const store = new CalendarStore(config);
  let failed = false;
  for (const account of config.accounts) {
    for (const key of ['password', 'client_secret', 'refresh_token'] as const) {
      const v = account[key];
      if (v && secretKind(v) === 'literal') console.log(`  ! ${account.id}.${key} is a plaintext secret; prefer keychain:/env:/cmd:`);
    }
    try {
      const { calendars, errors } = await store.calendars([account.id]);
      if (errors.length) throw new Error(errors[0].error);
      console.log(`✓ ${account.id} (${account.provider}) — ${calendars.length} calendar(s)`);
      for (const c of calendars) console.log(`    ${c.id.padEnd(32)} ${c.name}${c.writable ? '' : '  [read-only]'}`);
    } catch (e) {
      failed = true;
      console.log(`✗ ${account.id} (${account.provider}) — ${(e as Error).message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [url], () => {});
}

async function authGoogle(accountId: string | undefined) {
  const config = loadConfig();
  const google = config.accounts.filter((a) => a.provider === 'google');
  const account = accountId ? google.find((a) => a.id === accountId) : google.length === 1 ? google[0] : undefined;
  if (!account) throw new Error(`pass --account <id> (google accounts: ${google.map((a) => a.id).join(', ') || 'none configured'})`);
  const clientId = await resolveSecret(account.client_id!);
  const clientSecret = await resolveSecret(account.client_secret!);

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/') return void res.writeHead(404).end();
      const err = u.searchParams.get('error');
      const got = u.searchParams.get('code');
      if (err || !got || u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(`Authorization failed: ${err ?? 'bad response'}`);
        srv.close();
        return reject(new Error(`authorization failed: ${err ?? 'bad response'}`));
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('calendar-mcp is authorized. You can close this tab.');
      srv.close();
      resolve({ code: got, redirect });
    });
    let redirect = '';
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      redirect = `http://127.0.0.1:${port}`;
      const url = new URL(GOOGLE_AUTH_URL);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: GOOGLE_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        login_hint: account.username,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();
      console.log(`Opening browser to sign in as ${account.username}…\nIf it doesn't open, visit:\n${url}\n`);
      openBrowser(url.toString());
    });
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code.code,
      redirect_uri: code.redirect,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    }),
  });
  const tokens = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !tokens.refresh_token) {
    throw new Error(`token exchange failed: ${tokens.error_description ?? tokens.error ?? res.status}`);
  }

  const target = account.refresh_token ?? (process.platform === 'darwin' ? `keychain:calendar-mcp/${account.id}` : undefined);
  if (target && secretKind(target) === 'keychain') {
    await storeKeychain(target, tokens.refresh_token);
    console.log(`✓ Stored refresh token in Keychain (${target.slice('keychain:'.length)}).`);
    if (!account.refresh_token) console.log(`Add this to the "${account.id}" account in ${configPath()}:\n  refresh_token = "${target}"`);
  } else {
    console.log(`✓ Refresh token (store it where your config's refresh_token points):\n${tokens.refresh_token}`);
  }
  console.log('\nNext: calendar-mcp check');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'serve':
      return serve();
    case 'init':
      return init();
    case 'check':
      return check();
    case 'auth': {
      if (rest[0] !== 'google') throw new Error('usage: calendar-mcp auth google --account <id>');
      const i = rest.indexOf('--account');
      return authGoogle(i >= 0 ? rest[i + 1] : undefined);
    }
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return;
    case '-v':
    case '--version':
      console.log(VERSION);
      return;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(`calendar-mcp: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
