import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * Terminal prompts for the setup scripts.
 *
 * Two kinds: visible prompts with normal line editing, and secret prompts that
 * never echo what is typed. Secrets are read straight from stdin in raw mode
 * rather than through readline, because readline has no supported way to
 * suppress its own echo.
 */

export class PromptAbortedError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PromptAbortedError';
  }
}

/** Ask a question and echo what is typed, with normal line editing. */
export async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
    // readline leaves stdin flowing; a following secret prompt needs it idle.
    stdin.pause();
  }
}

/**
 * Ask for a value without echoing it.
 *
 * Each accepted character prints a `*` so the operator can see that typing is
 * registering and how long the value is, without the value itself appearing on
 * screen, in a scrollback buffer, or over a shared session.
 *
 * With piped (non-TTY) input there is no terminal echo to suppress, so the
 * question is read as an ordinary line.
 */
export async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return ask(question);
  }

  return new Promise<string>((resolve, reject) => {
    stdout.write(question);

    const previouslyRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(previouslyRaw);
      stdin.pause();
    };

    const onData = (chunk: string): void => {
      for (let i = 0; i < chunk.length; i += 1) {
        const char = chunk[i] as string;

        // Enter, or end-of-transmission: done.
        if (char === '\r' || char === '\n' || char === '\u0004') {
          // A CRLF terminator is two characters; do not leave the LF behind.
          let next = i + 1;
          if (char === '\r' && chunk[next] === '\n') next += 1;

          // Anything typed or pasted past the terminator belongs to the next
          // prompt, so hand it back to the stream instead of dropping it.
          const rest = chunk.slice(next);
          stdout.write('\n');
          cleanup();
          if (rest.length > 0) stdin.unshift(rest);
          resolve(value);
          return;
        }

        // Ctrl-C: abort the whole prompt.
        if (char === '\u0003') {
          stdout.write('\n');
          cleanup();
          reject(new PromptAbortedError());
          return;
        }

        // Backspace / delete: erase one masked character.
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }

        // Ctrl-U: clear the whole entry.
        if (char === '\u0015') {
          stdout.write('\b \b'.repeat(value.length));
          value = '';
          continue;
        }

        // Ignore control characters and escape sequences (arrow keys and
        // similar) rather than storing them as part of the secret.
        if (char >= ' ' && char !== '\u007f' && char !== '\u001b') {
          value += char;
          stdout.write('*');
        }
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Ask a yes/no question. Anything other than an explicit yes is a no, so a
 * stray keypress never triggers an action.
 */
export async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}
