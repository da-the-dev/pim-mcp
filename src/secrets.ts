import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Password-manager CLIs may wait for a biometric/GUI unlock, so cmd: gets longer.
const CMD_TIMEOUT_MS = 60_000;
const STORE_TIMEOUT_MS = 30_000;

/**
 * Resolve a secret reference from the config:
 *   env:NAME                  environment variable
 *   keychain:service/account  the OS secret store (macOS Keychain, Linux Secret Service, Windows DPAPI)
 *   cmd:<shell command>       stdout of a command (e.g. `op read op://…`, `pass show …`)
 * Anything else is used literally (discouraged; `check` warns about it).
 */
export async function resolveSecret(ref: string): Promise<string> {
  const kind = secretKind(ref);
  if (kind === 'env') {
    const name = ref.slice(4);
    const value = process.env[name];
    if (!value) throw new Error(`environment variable ${name} is not set`);
    return value;
  }
  if (kind === 'keychain') {
    const { service, account } = parseKeychainRef(ref);
    try {
      const value = await keychainRead(service, account);
      if (value) return value;
    } catch {}
    throw new Error(`no secret stored for "${service}/${account}" in the ${storeName()}; run: pim-mcp secret set ${service}/${account}`);
  }
  if (kind === 'cmd') {
    // shell: true uses the platform shell: /bin/sh, or cmd.exe on Windows.
    const stdout = await run(ref.slice(4), [], { shell: true, timeout: CMD_TIMEOUT_MS });
    const value = stdout.trim();
    if (!value) throw new Error(`command produced no output: ${ref.slice(4)}`);
    return value;
  }
  return ref;
}

export function secretKind(ref: string): 'env' | 'keychain' | 'cmd' | 'literal' {
  if (ref.startsWith('env:')) return 'env';
  if (ref.startsWith('keychain:')) return 'keychain';
  if (ref.startsWith('cmd:')) return 'cmd';
  return 'literal';
}

export function parseKeychainRef(ref: string): { service: string; account: string } {
  const body = ref.startsWith('keychain:') ? ref.slice('keychain:'.length) : ref;
  const slash = body.lastIndexOf('/');
  if (slash <= 0 || slash === body.length - 1) throw new Error(`keychain ref must look like keychain:service/account, got "${ref}"`);
  return { service: body.slice(0, slash), account: body.slice(slash + 1) };
}

export async function storeKeychain(ref: string, value: string): Promise<void> {
  const { service, account } = parseKeychainRef(ref);
  await keychainWrite(service, account, value);
}

export async function deleteKeychain(ref: string): Promise<void> {
  const { service, account } = parseKeychainRef(ref);
  if (process.platform === 'darwin') await run('security', ['delete-generic-password', '-s', service, '-a', account]);
  else if (process.platform === 'win32') rmSync(dpapiPath(service, account), { force: true });
  else await run('secret-tool', ['clear', 'service', service, 'account', account]);
}

export function storeName(): string {
  if (process.platform === 'darwin') return 'macOS Keychain';
  if (process.platform === 'win32') return 'Windows user secret store (DPAPI)';
  return 'Secret Service keyring (secret-tool)';
}

// ---------------------------------------------------------------- platform stores

interface RunOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  timeout?: number;
}

/**
 * Run a command and resolve with its stdout. stdin is always closed (after writing
 * `input`), because some programs, notably powershell.exe, otherwise wait on it forever.
 */
function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, shell: opts.shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timeout = opts.timeout ?? STORE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`\`${opts.shell ? cmd : [cmd, ...args.slice(0, 1)].join(' ')}\` timed out after ${timeout / 1000}s`));
    }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${opts.shell ? 'command' : cmd} exited with code ${code}`));
    });
    child.stdin.end(opts.input ?? '');
  });
}

// Windows has no built-in CLI for reading Credential Manager secrets, so secrets are
// DPAPI-encrypted files (readable only by the same Windows user on the same machine).
function dpapiPath(service: string, account: string): string {
  const safe = (s: string) => s.replace(/[<>:"/\\|?*]/g, '_');
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(base, 'pim-mcp', 'secrets', safe(service), `${safe(account)}.dpapi`);
}

const PS = ['-NoProfile', '-NonInteractive', '-Command'];

async function keychainRead(service: string, account: string): Promise<string> {
  if (process.platform === 'darwin') {
    const stdout = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    return stdout.replace(/\n$/, '');
  }
  if (process.platform === 'win32') {
    const script =
      '$s = Get-Content -Raw -LiteralPath $env:PIM_MCP_SECRET_PATH | ConvertTo-SecureString; ' +
      '[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)))';
    return run('powershell.exe', [...PS, script], { env: { PIM_MCP_SECRET_PATH: dpapiPath(service, account) } });
  }
  const stdout = await run('secret-tool', ['lookup', 'service', service, 'account', account]);
  return stdout.replace(/\n$/, '');
}

async function keychainWrite(service: string, account: string, value: string): Promise<void> {
  if (process.platform === 'darwin') {
    // `security` only takes the value via argv or an interactive prompt.
    await run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
    return;
  }
  if (process.platform === 'win32') {
    const path = dpapiPath(service, account);
    mkdirSync(join(path, '..'), { recursive: true });
    const script =
      '$v = [Console]::In.ReadToEnd(); ' +
      'ConvertTo-SecureString -String $v -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -NoNewline -LiteralPath $env:PIM_MCP_SECRET_PATH';
    await run('powershell.exe', [...PS, script], { input: value, env: { PIM_MCP_SECRET_PATH: path } });
    return;
  }
  try {
    await run('secret-tool', ['store', `--label=${service} ${account}`, 'service', service, 'account', account], { input: value });
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(
      missing
        ? 'secret-tool not found; install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch), or use env:/cmd: refs instead'
        : `could not store secret (is a keyring like GNOME Keyring or KWallet running?): ${(e as Error).message}`,
    );
  }
}
