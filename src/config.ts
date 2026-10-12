import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_KEYS = ['default_list'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface Config {
  default_list?: string;
}

export interface Credentials {
  email?: string;
  password?: string;
  clientId?: string;
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
}

export function configDir(): string {
  return process.env.ANYLIST_CONFIG_DIR || path.join(os.homedir(), '.config', 'anylist-cli');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  // Write then chmod so the mode holds even when the file already existed.
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export const configPath = (): string => path.join(configDir(), 'config.json');
export const credentialsPath = (): string => path.join(configDir(), 'credentials.json');

export function loadConfig(): Config {
  return readJson<Config>(configPath()) ?? {};
}

export function saveConfig(config: Config): void {
  writeJson(configPath(), config);
}

export function setConfigValue(key: string, value: string): void {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`);
  }
  saveConfig({ ...loadConfig(), [key]: value });
}

export function loadCredentials(): Credentials {
  return readJson<Credentials>(credentialsPath()) ?? {};
}

export function saveCredentials(credentials: Credentials): void {
  writeJson(credentialsPath(), credentials);
}

export function clearCredentials(): boolean {
  try {
    fs.unlinkSync(credentialsPath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
