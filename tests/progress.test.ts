import './helpers/test-credentials.js';
import './helpers/fast-progress.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressReporter } from '../src/services/notifier.js';
import {
  RateMeter,
  etaSeconds,
  percentOf,
  progressBar,
  renderProgress,
  resolvePercent,
  stagePercent,
  stepsFor,
} from '../src/services/progress.js';

/**
 * The live Telegram progress system.
 *
 * Two invariants matter more than any individual rendering detail:
 *   - a percentage is either byte-accurate or clearly labelled as pipeline
 *     position; nothing is ever interpolated or invented;
 *   - progress reporting cannot fail an upload, cannot spam the chat, and
 *     cannot put one user's progress in another user's chat.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// ---------------------------------------------------------------------------
// Fake Telegram
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  chatId: number;
  messageId?: number;
  text: string;
}

/** Records what would have been sent to Telegram, without a network. */
function fakeTelegram(opts: { failEdits?: boolean; nextMessageId?: number } = {}) {
  const calls: Call[] = [];
  let nextId = opts.nextMessageId ?? 1000;
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop() ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({
      method,
      chatId: Number(body['chat_id']),
      messageId: body['message_id'] === undefined ? undefined : Number(body['message_id']),
      text: String(body['text'] ?? ''),
    });

    if (method === 'editMessageText' && opts.failEdits) {
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: MESSAGE_ID_INVALID' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: nextId++ } : true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  return {
    calls,
    sends: () => calls.filter((c) => c.method === 'sendMessage'),
    edits: () => calls.filter((c) => c.method === 'editMessageText'),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 11 / 13 / 14 / 15 — honest numbers
// ---------------------------------------------------------------------------

test('a transfer percentage comes from bytes, never from a guess', () => {
  assert.equal(percentOf(700 * MiB, 1400 * MiB), 50);
  assert.equal(percentOf(0, 1400 * MiB), 0);
  assert.equal(percentOf(1400 * MiB, 1400 * MiB), 100);
});

test('a processing stage reports pipeline position and says so', () => {
  const view = { stage: 'IDENTIFYING' as const, route: 'telegram-local' as const, filename: 'x.mkv' };
  const { percent, byteAccurate } = resolvePercent(view);

  assert.equal(byteAccurate, false, 'identification has no byte count to report');
  assert.ok(percent > 0 && percent < 100);

  const text = renderProgress(view);
  assert.match(text, /step \d+ of \d+/, 'the bar is labelled as pipeline position');
  assert.doesNotMatch(text, /ETA/, 'no ETA is invented for a stage without bytes');
  assert.doesNotMatch(text, /\/s/, 'no transfer rate is invented either');
});

test('a stage percentage only ever depends on the stage, not on elapsed time', () => {
  const steps = stepsFor('telegram-local');
  const a = stagePercent('IDENTIFYING', steps);
  const b = stagePercent('IDENTIFYING', steps);
  assert.equal(a, b, 'the same stage always reports the same percentage');
  assert.ok(stagePercent('TMDB', steps) > a, 'and it only moves when the stage does');
});

test('the checklist lists only the steps this route actually performs', () => {
  const multipart = renderProgress({ stage: 'IDENTIFYING', route: 'multipart', filename: 'x.mkv' });
  assert.match(multipart, /Assembling parts/);
  assert.doesNotMatch(multipart, /Fetching from Telegram/, 'a multipart upload is never fetched');

  const telegram = renderProgress({ stage: 'IDENTIFYING', route: 'telegram-local', filename: 'x.mkv' });
  assert.match(telegram, /Fetching from Telegram/);
  assert.doesNotMatch(telegram, /Assembling parts/, 'a Bot API upload never assembles parts');
});

test('transfer rate is measured over a rolling window', () => {
  const meter = new RateMeter(10_000);
  const t0 = 1_000_000;
  assert.equal(meter.bytesPerSecond(), null, 'one sample cannot establish a rate');

  for (let i = 0; i <= 4; i += 1) meter.record(i * 8 * MiB, t0 + i * 1000);
  const rate = meter.bytesPerSecond();
  assert.ok(rate !== null);
  assert.ok(Math.abs(rate - 8 * MiB) < 0.2 * MiB, `expected ~8 MiB/s, got ${rate}`);
});

test('a stall decays the rate instead of freezing it', () => {
  const meter = new RateMeter(4000);
  const t0 = 2_000_000;
  for (let i = 0; i <= 4; i += 1) meter.record(i * MiB, t0 + i * 1000);
  const moving = meter.bytesPerSecond() ?? 0;

  // Transfer stops: further samples repeat the same byte count.
  for (let i = 5; i <= 12; i += 1) meter.record(4 * MiB, t0 + i * 1000);
  const stalled = meter.bytesPerSecond();
  assert.ok(stalled === null || stalled < moving / 2, `stalled rate should collapse, got ${stalled}`);
});

test('ETA is computed from the real rate, and omitted when it cannot be', () => {
  assert.equal(etaSeconds(0.5 * GiB, 1 * GiB, 1 * MiB), 512);
  assert.equal(etaSeconds(1 * GiB, 1 * GiB, 1 * MiB), 0, 'nothing left to transfer');
  assert.equal(etaSeconds(0, 1 * GiB, null), null, 'no rate yet, so no ETA');
  assert.equal(etaSeconds(0, 1 * GiB, 0), null, 'a zero rate cannot produce an ETA');
  assert.equal(etaSeconds(0, 0, 5 * MiB), null, 'unknown total, so no ETA');
});

test('a zero-byte file does not produce NaN or a divide-by-zero', () => {
  assert.equal(percentOf(0, 0), null);
  const text = renderProgress({ stage: 'DOWNLOADING', route: 'mtproto', filename: 'empty.mkv', bytes: 0, total: 0 });
  assert.doesNotMatch(text, /NaN|Infinity/);
});

test('the bar is clamped and never renders a partial cell wrongly', () => {
  assert.equal(progressBar(0, 10), '░'.repeat(10));
  assert.equal(progressBar(100, 10), '█'.repeat(10));
  assert.equal(progressBar(50, 10), '█'.repeat(5) + '░'.repeat(5));
  assert.equal(progressBar(-20, 10), '░'.repeat(10), 'negatives clamp to empty');
  assert.equal(progressBar(500, 10), '█'.repeat(10), 'overshoot clamps to full');
  assert.equal(progressBar(Number.NaN, 10), '░'.repeat(10));
});

// ---------------------------------------------------------------------------
// 1 / 2 / 16 — transfer reporting
// ---------------------------------------------------------------------------

test('a normal upload reports real bytes, rate and ETA', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(111, null, 'Movie.2026.mkv', undefined, 'telegram-local');
    await reporter.setStage('DOWNLOADING');
    // Spread over more than the rate meter's minimum window, so a rate — and
    // therefore an ETA — can honestly be established.
    for (let i = 1; i <= 6; i += 1) {
      await reporter.reportTransfer(i * 200 * MiB, 1400 * MiB);
      await sleep(150);
    }
    const last = tg.calls[tg.calls.length - 1]!;
    assert.match(last.text, /\d+%/);
    assert.match(last.text, /MiB|GiB/, 'byte counts are shown');
    assert.match(last.text, /ETA/, 'an ETA appears once a rate is known');
  } finally {
    tg.restore();
  }
});

test('a multi-gigabyte transfer reports without precision loss', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(112, 500, 'Huge.mkv', undefined, 'mtproto');
    await reporter.setStage('DOWNLOADING');
    await reporter.reportTransfer(4.5 * GiB, 5 * GiB);
    const snapshot = reporter.snapshot();
    assert.equal(Math.round(snapshot.percent), 90);
    assert.equal(snapshot.bytes, 4.5 * GiB);
  } finally {
    tg.restore();
  }
});

test('completion reports 100% and is always sent, whatever the rate limit says', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(113, 500, 'Movie.mkv', undefined, 'telegram-local');
    await reporter.setStage('DOWNLOADING');
    const before = tg.calls.length;
    // Immediately at 100%: inside the rate-limit window, but terminal.
    await reporter.reportTransfer(1400 * MiB, 1400 * MiB);
    assert.ok(tg.calls.length > before, 'the final update is not suppressed');
    assert.equal(Math.round(reporter.snapshot().percent), 100);
  } finally {
    tg.restore();
  }
});

// ---------------------------------------------------------------------------
// 4 — multipart
// ---------------------------------------------------------------------------

test('a multi-part upload shows the part and the overall percentage', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(114, 600, 'Big.mkv', undefined, 'multipart');
    await reporter.setStage('ASSEMBLING');
    reporter.setPart(2, 3);
    // Past the rate-limit window, so this update actually reaches Telegram.
    await sleep(80);
    await reporter.reportTransfer(2 * GiB, 3 * GiB);

    const last = tg.calls[tg.calls.length - 1]!;
    assert.match(last.text, /Part 2\/3/);
    assert.match(last.text, /67%/, 'the overall percentage is shown alongside the part');
    assert.deepEqual(reporter.snapshot().part, { index: 2, count: 3 });
  } finally {
    tg.restore();
  }
});

// ---------------------------------------------------------------------------
// 6 / 12 — one message, no spam
// ---------------------------------------------------------------------------

test('one upload produces one message, edited in place', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(115, null, 'Movie.mkv', undefined, 'telegram-local');
    await reporter.setStage('DOWNLOADING');
    for (let i = 1; i <= 20; i += 1) {
      await reporter.reportTransfer(i * 70 * MiB, 1400 * MiB);
      await sleep(10);
    }
    assert.equal(tg.sends().length, 1, 'exactly one message is ever sent');
    assert.ok(tg.edits().length >= 1, 'and it is edited thereafter');
    const ids = new Set(tg.edits().map((c) => c.messageId));
    assert.equal(ids.size, 1, 'every edit targets the same message');
  } finally {
    tg.restore();
  }
});

test('rapid byte updates are rate-limited rather than sent one per chunk', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(116, 700, 'Movie.mkv', undefined, 'telegram-local');
    await reporter.setStage('DOWNLOADING');
    const baseline = tg.calls.length;

    // 200 chunk callbacks with no delay: one Telegram call each would be spam.
    for (let i = 1; i <= 200; i += 1) await reporter.reportTransfer(i * 7 * MiB, 1400 * MiB);

    const sent = tg.calls.length - baseline;
    assert.ok(sent < 20, `expected far fewer than 200 calls, got ${sent}`);
  } finally {
    tg.restore();
  }
});

// ---------------------------------------------------------------------------
// 5 / 17 — isolation
// ---------------------------------------------------------------------------

test("two simultaneous uploads never write into each other's chat", async () => {
  const tg = fakeTelegram();
  try {
    const a = new ProgressReporter(1111, 10, 'A.mkv', undefined, 'telegram-local');
    const b = new ProgressReporter(2222, 20, 'B.mkv', undefined, 'mtproto');

    await Promise.all([
      (async () => {
        await a.setStage('DOWNLOADING');
        for (let i = 1; i <= 5; i += 1) {
          await a.reportTransfer(i * 100 * MiB, 500 * MiB);
          await sleep(20);
        }
      })(),
      (async () => {
        await b.setStage('DOWNLOADING');
        for (let i = 1; i <= 5; i += 1) {
          await b.reportTransfer(i * 400 * MiB, 2000 * MiB);
          await sleep(20);
        }
      })(),
    ]);

    for (const call of tg.calls) {
      if (call.chatId === 1111) {
        assert.ok(!call.text.includes('B.mkv'), "user B's filename reached user A's chat");
        assert.equal(call.messageId, 10);
      }
      if (call.chatId === 2222) {
        assert.ok(!call.text.includes('A.mkv'), "user A's filename reached user B's chat");
        assert.equal(call.messageId, 20);
      }
    }
    // Independent state, not a shared global.
    assert.notEqual(a.snapshot().bytes, b.snapshot().bytes);
  } finally {
    tg.restore();
  }
});

// ---------------------------------------------------------------------------
// 7 — Telegram failures must not matter
// ---------------------------------------------------------------------------

test('an upload continues when every Telegram edit fails', async () => {
  const tg = fakeTelegram({ failEdits: true });
  try {
    const reporter = new ProgressReporter(117, 800, 'Movie.mkv', undefined, 'telegram-local');
    // None of these may throw, whatever Telegram says.
    await reporter.setStage('DOWNLOADING');
    await reporter.reportTransfer(500 * MiB, 1000 * MiB);
    await reporter.setStage('IDENTIFYING');
    await reporter.setText('done');
    assert.ok(tg.edits().length > 0, 'edits were attempted');
    assert.equal(reporter.snapshot().stage, 'IDENTIFYING', 'state advanced regardless');
  } finally {
    tg.restore();
  }
});

test('a throwing dashboard sink cannot break progress reporting', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(
      118,
      900,
      'Movie.mkv',
      () => {
        throw new Error('database is down');
      },
      'telegram-local',
    );
    await reporter.setStage('DOWNLOADING');
    await reporter.reportTransfer(1, 100);
    assert.equal(reporter.snapshot().stage, 'DOWNLOADING');
  } finally {
    tg.restore();
  }
});

// ---------------------------------------------------------------------------
// 8 — worker restart
// ---------------------------------------------------------------------------

test('a restarted worker edits the existing message instead of sending a new one', async () => {
  const tg = fakeTelegram();
  try {
    // First worker: no message yet, so one is sent and its id recorded.
    const first = new ProgressReporter(119, null, 'Movie.mkv', undefined, 'telegram-local');
    await first.setStage('DOWNLOADING');
    const messageId = first.messageId;
    assert.ok(messageId !== null, 'the id is available to persist on the upload row');
    assert.equal(tg.sends().length, 1);

    // Worker restarts and rebuilds the reporter from the persisted id.
    const second = new ProgressReporter(119, messageId, 'Movie.mkv', undefined, 'telegram-local');
    await second.setStage('IDENTIFYING');

    assert.equal(tg.sends().length, 1, 'no second progress message is created');
    assert.equal(tg.edits().at(-1)?.messageId, messageId, 'it resumes the same message');
  } finally {
    tg.restore();
  }
});

// ---------------------------------------------------------------------------
// 9 / 10 — terminal states replace the progress message
// ---------------------------------------------------------------------------

test('a failure edits the progress message rather than adding another', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(120, 950, 'Movie.mkv', undefined, 'telegram-local');
    await reporter.setStage('FETCHING');
    await reporter.setText('❌ <b>Upload failed</b>\n\nStage: Fetching from Telegram');

    assert.equal(tg.sends().length, 0, 'nothing new was sent');
    const last = tg.edits().at(-1)!;
    assert.equal(last.messageId, 950);
    assert.match(last.text, /Upload failed/);
    assert.match(last.text, /Stage:/, 'the failing stage is named for the user');
  } finally {
    tg.restore();
  }
});

test('success replaces the progress message in place', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(121, 960, 'Movie.mkv', undefined, 'telegram-local');
    await reporter.setStage('JELLYFIN_VERIFY');
    await reporter.setText('✅ <b>Upload complete!</b>');

    assert.equal(tg.sends().length, 0, 'the progress message is reused, not left behind');
    assert.match(tg.edits().at(-1)!.text, /Upload complete/);
  } finally {
    tg.restore();
  }
});

// ---------------------------------------------------------------------------
// Snapshot for the dashboard
// ---------------------------------------------------------------------------

test('the dashboard snapshot says whether the percentage came from bytes', async () => {
  const tg = fakeTelegram();
  try {
    const seen: Array<{ stage: string; byteAccurate: boolean; percent: number }> = [];
    const reporter = new ProgressReporter(
      122,
      970,
      'Movie.mkv',
      (s) => {
        seen.push({ stage: s.stage, byteAccurate: s.byteAccurate, percent: s.percent });
      },
      'telegram-local',
    );

    await reporter.setStage('DOWNLOADING');
    await reporter.reportTransfer(250 * MiB, 1000 * MiB);
    await reporter.setStage('TMDB');

    const transfer = seen.find((s) => s.stage === 'DOWNLOADING' && s.byteAccurate);
    assert.ok(transfer, 'a byte-accurate snapshot was published');
    assert.equal(Math.round(transfer.percent), 25);

    const processing = seen.find((s) => s.stage === 'TMDB');
    assert.ok(processing, 'a processing snapshot was published');
    assert.equal(processing.byteAccurate, false, 'and it is marked as pipeline position');
  } finally {
    tg.restore();
  }
});

test('the dashboard is updated even while Telegram edits are rate-limited', async () => {
  const tg = fakeTelegram();
  try {
    let snapshots = 0;
    const reporter = new ProgressReporter(123, 980, 'Movie.mkv', () => {
      snapshots += 1;
    }, 'telegram-local');

    await reporter.setStage('DOWNLOADING');
    const telegramBefore = tg.calls.length;
    const snapshotsBefore = snapshots;

    for (let i = 1; i <= 50; i += 1) await reporter.reportTransfer(i * MiB, 1000 * MiB);

    assert.equal(snapshots - snapshotsBefore, 50, 'every sample reached the dashboard');
    assert.ok(tg.calls.length - telegramBefore < 50, 'but Telegram was spared most of them');
  } finally {
    tg.restore();
  }
});

test('the message id is published so it can be persisted against the upload', async () => {
  const tg = fakeTelegram();
  try {
    const ids: Array<number | null> = [];
    const reporter = new ProgressReporter(
      124,
      null,
      'Movie.mkv',
      (s) => {
        ids.push(s.messageId);
      },
      'telegram-local',
    );
    await reporter.setStage('DOWNLOADING');
    // Without this the caller cannot record the id, and a restarted worker
    // would send a second progress message.
    assert.ok(
      ids.some((id) => id !== null),
      'a snapshot carried the created message id',
    );
  } finally {
    tg.restore();
  }
});

test('a chat that cannot be written to is not retried on every tick', async () => {
  const failing = fakeTelegram();
  // Every sendMessage fails, as it does for a blocked or deleted chat.
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    const reporter = new ProgressReporter(125, null, 'Movie.mkv', undefined, 'telegram-local');
    let attempts = 0;
    const counting = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      attempts += 1;
      return counting(...args);
    }) as typeof fetch;

    await reporter.setStage('DOWNLOADING');
    for (let i = 1; i <= 40; i += 1) await reporter.reportTransfer(i * 1024 * 1024, 40 * 1024 * 1024);

    assert.ok(attempts < 10, `expected a backoff, but the API was called ${attempts} times`);
    assert.equal(reporter.messageId, null, 'no message was ever created');
  } finally {
    globalThis.fetch = original;
    failing.restore();
  }
});

// ---------------------------------------------------------------------------
// Queue position — the fix for "it looks frozen"
// ---------------------------------------------------------------------------

test('a queued upload shows its real position and never a fake percentage', () => {
  const text = renderProgress({
    stage: 'QUEUED',
    route: 'telegram-local',
    filename: 'Movie.mkv',
    queue: { ahead: 2, active: 2 },
    elapsedMs: 95_000,
  });

  assert.match(text, /Position 3 in the queue/, 'ahead=2 means third in line');
  assert.match(text, /2 uploads in progress/);
  assert.doesNotMatch(text, /%/, 'a queued upload has no percentage to report');
  assert.doesNotMatch(text, /ETA/, 'and no ETA can honestly be given');
  assert.doesNotMatch(text, /Identifying/, 'it must not claim a stage that has not started');
});

test('the head of the queue is told so plainly', () => {
  const text = renderProgress({
    stage: 'QUEUED',
    route: 'mtproto',
    filename: 'Movie.mkv',
    queue: { ahead: 0, active: 1 },
  });
  assert.match(text, /Next in line/);
});

test('reportQueued only edits when the position actually changes', async () => {
  const tg = fakeTelegram();
  try {
    const reporter = new ProgressReporter(140, 900, 'Movie.mkv', undefined, 'telegram-local');
    await reporter.reportQueued(3, 2);
    const afterFirst = tg.calls.length;

    // Same position, repeatedly: a queue sweep runs every few seconds and must
    // not turn a long wait into a stream of identical edits.
    for (let i = 0; i < 10; i += 1) await reporter.reportQueued(3, 2);
    assert.equal(tg.calls.length, afterFirst, 'an unchanged position costs nothing');

    await reporter.reportQueued(1, 2);
    assert.ok(tg.calls.length > afterFirst, 'but movement is reported');
    assert.match(tg.calls.at(-1)!.text, /Position 2/);
  } finally {
    tg.restore();
  }
});

test('the queued stage is part of every ingestion route', () => {
  for (const route of ['telegram-local', 'telegram-cloud', 'mtproto', 'multipart', 'direct'] as const) {
    assert.ok(stepsFor(route).includes('QUEUED'), `${route} waits in the queue like any other`);
  }
});
