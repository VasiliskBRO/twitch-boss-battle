import test from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../../src/config.js';
import { OutboundQueue, splitMessage } from '../../twitch/outbound_queue.js';
import { maxInWindow } from '../../twitch/loadtest.js';

const T = CONFIG.TWITCH;
const silent = { info() {}, warn() {}, error() {} };

// Очередь на фейковых часах; sent — что «ушло в Твич».
function setup({ isMod = true, failTimes = 0 } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const sent = [];
  const consoleOut = [];
  let fails = failTimes;
  const q = new OutboundQueue({
    config: T,
    now: clock.now,
    log: silent,
    onConsole: (text) => consoleOut.push(text),
    send: async (text, opts) => {
      if (fails > 0) {
        fails--;
        throw new Error('boom');
      }
      sent.push({ text, at: clock.now(), priority: opts.priority });
    },
  });
  q.setMode(isMod);
  // Прокрутить время шагами по 50 мс, качая очередь.
  const run = async (ms) => {
    for (let i = 0; i < ms / 50; i++) {
      await q.pump();
      clock.advance(50);
    }
  };
  return { q, clock, sent, consoleOut, run };
}

test('Лимит: в любом окне 30 с не больше 85 (модератор) / 17 (обычный), интервал 0.35 / 1.2 с', async () => {
  for (const isMod of [true, false]) {
    const { q, sent, run } = setup({ isMod });
    for (let i = 0; i < 150; i++) q.enqueue({ text: `сообщение ${i}`, priority: 'high' }); // high не удаляются
    await run(150_000);
    const lim = isMod ? T.limits.mod : T.limits.normal;
    const times = sent.map((s) => s.at);
    assert.ok(maxInWindow(times, 30_000) <= lim.perWindow, `${maxInWindow(times, 30_000)} > ${lim.perWindow}`);
    assert.strictEqual(maxInWindow(times, 30_000), lim.perWindow, 'лимит используется полностью');
    const minGap = Math.min(...times.slice(1).map((x, i) => x - times[i]));
    assert.ok(minGap >= lim.minIntervalMs, `интервал ${minGap}`);
  }
});

test('Приоритеты: high → normal → low, внутри приоритета по порядку', async () => {
  const { q, sent, run } = setup();
  q.enqueue({ text: 'low1', priority: 'low' });
  q.enqueue({ text: 'normal1', priority: 'normal' });
  q.enqueue({ text: 'high1', priority: 'high' });
  q.enqueue({ text: 'normal2', priority: 'normal' });
  q.enqueue({ text: 'high2', priority: 'high' });
  q.enqueue({ text: 'без приоритета' });
  await run(5000);
  assert.deepStrictEqual(sent.map((s) => s.text), ['high1', 'high2', 'normal1', 'normal2', 'без приоритета', 'low1']);
});

test('low удаляются по возрасту и при переполнении; high — никогда', async () => {
  const age = setup({ isMod: false });
  age.q.setConnected(false);
  age.q.setConnected(true);
  age.q.enqueue({ text: 'старый low', priority: 'low' });
  age.clock.advance(T.lowMaxAgeSeconds * 1000 + 1);
  await age.q.pump();
  assert.deepStrictEqual(age.sent, []);
  assert.strictEqual(age.q.stats.droppedBy.low_age, 1);

  const { q } = setup();
  for (let i = 0; i < 150; i++) q.enqueue({ text: `h${i}`, priority: 'high' });
  for (let i = 0; i < 100; i++) q.enqueue({ text: `n${i}`, priority: 'normal' });
  for (let i = 0; i < 50; i++) q.enqueue({ text: `l${i}`, priority: 'low' });
  assert.strictEqual(q.length, T.queueMax);
  assert.deepStrictEqual([q.queues.high.length, q.queues.normal.length, q.queues.low.length], [150, 50, 0]);
  assert.strictEqual(q.queues.normal[0].text, 'n50', 'удалены самые старые normal');
  assert.strictEqual(q.stats.droppedBy.overflow, 100);

  const onlyHigh = setup();
  for (let i = 0; i < 300; i++) onlyHigh.q.enqueue({ text: `h${i}`, priority: 'high' });
  assert.strictEqual(onlyHigh.q.length, 300, 'high не удаляются даже сверх queueMax');
  assert.strictEqual(onlyHigh.q.stats.dropped, 0);
});

test('Дубликаты: одинаковый текст в течение 30 с меняется « ·2», « ·3», а не теряется', async () => {
  const { q, sent, run, clock } = setup();
  for (let i = 0; i < 3; i++) q.enqueue({ text: '👥 В отряде уже 10 бойцов' });
  await run(3000);
  assert.deepStrictEqual(sent.map((s) => s.text), ['👥 В отряде уже 10 бойцов', '👥 В отряде уже 10 бойцов ·2', '👥 В отряде уже 10 бойцов ·3']);
  clock.advance(31_000);
  q.enqueue({ text: '👥 В отряде уже 10 бойцов' });
  await run(1000);
  assert.strictEqual(sent.at(-1).text, '👥 В отряде уже 10 бойцов', 'через 30 с — снова без суффикса');
  q.enqueue({ text: 'x'.repeat(500) });
  q.enqueue({ text: 'x'.repeat(500) });
  await run(2000);
  assert.ok(sent.at(-1).text.length <= 500 && sent.at(-1).text.endsWith(' ·2'));
});

test('Длинные сообщения разбиваются по « | », затем по пробелам', async () => {
  const long = Array.from({ length: 20 }, (_, i) => `часть ${i} ${'слово '.repeat(8).trim()}`).join(' | ');
  const parts = splitMessage(long);
  assert.ok(long.length > 1000 && parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 500, String(p.length));
  assert.strictEqual(parts.join(' | '), long, 'ничего не потеряно');
  const words = splitMessage('слово '.repeat(200).trim());
  assert.ok(words.every((p) => p.length <= 500 && !p.startsWith(' ') && !p.endsWith(' ')));
  assert.deepStrictEqual(splitMessage('a'.repeat(1100)).map((p) => p.length), [500, 500, 100]);

  const { q, sent, run } = setup();
  q.enqueue({ text: long, priority: 'high' });
  await run(5000);
  assert.strictEqual(sent.length, parts.length);
});

test('Без связи: не отправляет, low удаляет, high и normal держит не дольше 10 с', async () => {
  const { q, sent, run, clock } = setup();
  q.setConnected(false);
  q.enqueue({ text: 'старый high', priority: 'high' });
  q.enqueue({ text: 'старый normal', priority: 'normal' });
  clock.advance(6000);
  q.enqueue({ text: 'свежий high', priority: 'high' });
  q.enqueue({ text: 'low', priority: 'low' });
  await run(5000); // прошло 11 с от первых
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(q.queues.high.map((i) => i.text), ['свежий high']);
  assert.deepStrictEqual([q.queues.normal.length, q.queues.low.length], [0, 0]);
  q.setConnected(true);
  await run(1000);
  assert.deepStrictEqual(sent.map((s) => s.text), ['свежий high']);
});

test('Ошибка отправки: один повтор через 2 с, потом удаление с записью в лог', async () => {
  const once = setup({ failTimes: 1 });
  once.q.enqueue({ text: 'дойдёт со второй попытки', priority: 'high' });
  await once.run(1900);
  assert.deepStrictEqual(once.sent, []);
  await once.run(600);
  assert.deepStrictEqual(once.sent.map((s) => s.text), ['дойдёт со второй попытки']);

  const twice = setup({ failTimes: 2 });
  twice.q.enqueue({ text: 'не дойдёт', priority: 'high' });
  await twice.run(5000);
  assert.deepStrictEqual(twice.sent, []);
  assert.strictEqual(twice.q.stats.droppedBy.send_failed, 1);
  assert.strictEqual(twice.q.length, 0);
});

test('console печатается локально; whisper — в чат только при whisperFallbackToChat', async () => {
  const { q, sent, consoleOut, run } = setup();
  q.enqueue({ text: '[рука стримера] секрет', to: 'console' });
  q.enqueue({ text: 'шёпот', to: 'whisper' });
  await run(2000);
  assert.deepStrictEqual(consoleOut, ['[рука стримера] секрет']);
  assert.deepStrictEqual(sent, []);

  const fb = new OutboundQueue({ config: { ...T, whisperFallbackToChat: true }, now: () => 0, log: silent, send: async () => {} });
  fb.enqueue({ text: 'шёпот', to: 'whisper' });
  assert.strictEqual(fb.length, 1);
});

test('maxInWindow считает скользящее окно', () => {
  assert.strictEqual(maxInWindow([0, 10, 29_999, 30_000, 30_010], 30_000), 3);
  assert.strictEqual(maxInWindow([], 30_000), 0);
});
