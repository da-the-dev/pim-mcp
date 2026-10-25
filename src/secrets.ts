import { exec, execFile, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const runShell = promisify(exec);

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
    // exec uses the platform shell: /bin/sh, or cmd.exe on Windows.
    const { stdout } = await runShell(ref.slice(4));
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

/** Run a command, feeding `input` on stdin; resolves with stdout. */
function runWithInput(cmd: string, args: string[], input: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited with ${code}`))));
    child.stdin.end(input);
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
    const { stdout } = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    return stdout.replace(/\n$/, '');
  }
  if (process.platform === 'win32') {
    const script =
      '$s = Get-Content -Raw -LiteralPath $env:PIM_MCP_SECRET_PATH | ConvertTo-SecureString; ' +
      '[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)))';
    const { stdout } = await run('powershell.exe', [...PS, script], { env: { ...process.env, PIM_MCP_SECRET_PATH: dpapiPath(service, account) } });
    return stdout;
  }
  const { stdout } = await run('secret-tool', ['lookup', 'service', service, 'account', account]);
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
    await runWithInput('powershell.exe', [...PS, script], value, { PIM_MCP_SECRET_PATH: path });
    return;
  }
  try {
    await runWithInput('secret-tool', ['store', `--label=${service} ${account}`, 'service', service, 'account', account], value);
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(
      missing
        ? 'secret-tool not found; install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch), or use env:/cmd: refs instead'
        : `could not store secret (is a keyring like GNOME Keyring or KWallet running?): ${(e as Error).message}`,
    );
  }
}
