import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';

/**
 * Reading and writing individual keys in `.env`.
 *
 * Setup scripts use this so secrets are typed once at a terminal and land
 * straight in the file, rather than passing through a shell history, a command
 * line, or a chat window.
 */

export const ENV_PATH = path.join(config.projectRoot, '.env');

/** Set or replace one key, preserving comments, ordering and every other line. */
export async function setEnvKey(key: string, value: string): Promise<string> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Refusing to write an .env key named ${JSON.stringify(key)}`);
  // A newline would end this key and begin another; every other reader of the
  // file (dotenv, systemd, docker compose) would then disagree about the rest.
  if (/[\r\n]/.test(value)) throw new Error(`The value for ${key} must not contain a line break`);

  let content = await fsp.readFile(ENV_PATH, 'utf8').catch(() => '');

  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');

  // The replacement is a function so that `$&`, `$'` and friends inside a
  // secret are written literally rather than interpreted by String.replace.
  content = pattern.test(content)
    ? content.replace(pattern, () => line)
    : `${content.replace(/\n*$/, '\n')}${line}\n`;

  await fsp.writeFile(ENV_PATH, content, { mode: 0o600 });
  await fsp.chmod(ENV_PATH, 0o600);
  return ENV_PATH;
}

/** Current value of a key in `.env`, or `''`. */
export async function getEnvKey(key: string): Promise<string> {
  const content = await fsp.readFile(ENV_PATH, 'utf8').catch(() => '');
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

/** `1234…7890` — enough to recognise a value without revealing it. */
export function maskSecret(value: string): string {
  if (!value) return '(not set)';
  if (value.length <= 12) return '(set)';
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}
