/**
 * Feeds scripted answers into a pty-attached process, one line at a time.
 *
 * Used by tests/setup-prompts.e2e.mjs. The answers arrive on stdout, which the
 * caller pipes into `script`, which relays them into the pseudo-terminal — so
 * the process under test sees a real TTY and takes its interactive code path.
 *
 * Answers come from JELLYGRAM_ANSWERS as a JSON array. The pauses give the script
 * time to consume each answer and switch stdin between line mode and raw mode
 * before the next one arrives.
 *
 *   JELLYGRAM_ANSWERS='["a","b"]' node answer-feeder.mjs | script -qec '<cmd>' /dev/null
 */

const answers = JSON.parse(process.env.JELLYGRAM_ANSWERS ?? '[]');
const START_DELAY_MS = Number(process.env.JELLYGRAM_START_DELAY_MS ?? 1800);
const GAP_MS = Number(process.env.JELLYGRAM_GAP_MS ?? 500);
const TAIL_MS = Number(process.env.JELLYGRAM_TAIL_MS ?? 2500);

let index = 0;

function tick() {
  if (index >= answers.length) {
    // Stay open a moment so the child can finish writing its output.
    setTimeout(() => process.exit(0), TAIL_MS);
    return;
  }
  process.stdout.write(`${answers[index]}\n`);
  index += 1;
  setTimeout(tick, GAP_MS);
}

setTimeout(tick, START_DELAY_MS);
