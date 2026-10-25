import type { AccountConfig } from './config.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar';

const PRESET_URLS: Partial<Record<AccountConfig['provider'], string>> = {
  icloud: 'https://caldav.icloud.com',
  google: 'https://apidata.googleusercontent.com/caldav/v2/',
};

export function serverUrl(account: AccountConfig): string {
  const url = account.url ?? PRESET_URLS[account.provider];
  if (!url) throw new Error(`account "${account.id}": no url configured`);
  return url;
}
