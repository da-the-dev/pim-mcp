import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';

const Account = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'use letters, digits, - or _'),
    provider: z.enum(['nextcloud', 'icloud', 'google', 'caldav']),
    url: z.string().url().optional(),
    username: z.string().min(1),
    // Basic auth (nextcloud, icloud, caldav)
    password: z.string().optional(),
    // OAuth (google)
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    refresh_token: z.string().optional(),
    read_only: z.boolean().default(false),
    // Calendar names (case-insensitive) to hide or to protect from writes.
    hide_calendars: z.array(z.string()).default([]),
    read_only_calendars: z.array(z.string()).default([]),
  })
  .superRefine((a, ctx) => {
    if ((a.provider === 'nextcloud' || a.provider === 'caldav') && !a.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: `url is required for provider "${a.provider}"` });
    }
    if (a.provider === 'google') {
      for (const k of ['client_id', 'client_secret'] as const) {
        if (!a[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required for provider "google"` });
      }
    } else if (!a.password) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'password is required' });
    }
  });

const Config = z.object({
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  guardrails: z
    .object({
      allow_delete: z.boolean().default(false),
      allow_invites: z.boolean().default(false),
    })
    .default({ allow_delete: false, allow_invites: false }),
  accounts: z.array(Account).min(1, 'add at least one [[accounts]] entry'),
});

export type AccountConfig = z.infer<typeof Account>;
export type Config = z.infer<typeof Config>;

export function configPath(): string {
  if (process.env.PIM_MCP_CONFIG) return process.env.PIM_MCP_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'pim-mcp', 'config.toml');
}

export function parseConfig(toml: string): Config {
  const result = Config.safeParse(parse(toml));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid config:\n${issues.join('\n')}`);
  }
  const cfg = result.data;
  try {
    new Intl.DateTimeFormat('en', { timeZone: cfg.timezone });
  } catch {
    throw new Error(`Invalid config: unknown timezone "${cfg.timezone}" (use an IANA name like Europe/Amsterdam)`);
  }
  const ids = cfg.accounts.map((a) => a.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`Invalid config: duplicate account id "${dup}"`);
  return cfg;
}

export function loadConfig(path = configPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`No config found at ${path}. Create it (see README) or set PIM_MCP_CONFIG.`);
  }
  return parseConfig(raw);
}
