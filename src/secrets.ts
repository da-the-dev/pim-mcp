import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Resolve a secret reference from the config:
 *   env:NAME                  environment variable
 *   keychain:service/account  macOS Keychain generic password
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
    if (process.platform !== 'darwin') throw new Error('keychain: refs only work on macOS; use env: or cmd: instead');
    try {
      const { stdout } = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
      return stdout.replace(/\n$/, '');
    } catch {
      throw new Error(`no Keychain item for service "${service}", account "${account}"`);
    }
  }
  if (kind === 'cmd') {
    const { stdout } = await run('/bin/sh', ['-c', ref.slice(4)]);
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
  const body = ref.slice('keychain:'.length);
  const slash = body.lastIndexOf('/');
  if (slash <= 0 || slash === body.length - 1) throw new Error(`keychain ref must look like keychain:service/account, got "${ref}"`);
  return { service: body.slice(0, slash), account: body.slice(slash + 1) };
}

export async function storeKeychain(ref: string, value: string): Promise<void> {
  const { service, account } = parseKeychainRef(ref);
  await run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
}
