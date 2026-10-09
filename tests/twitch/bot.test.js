import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../../src/config.js';
import { createBot } from '../../twitch/bot.js';
import { FakeAdapter } from '../../twitch/fake_adapter.js';
import { runLoadTest, maxInWindow, makeRng } from '../../twitch/loadtest.js';

const T = CONFIG.TWITCH;
const STREAMER = { broadcaster: '1' };
const MOD = { moderator: '1' };

// Бот на фейковых часах и фейковых таймерах. run(ms) двигает время шагами по 50 мс:
// срабатывают таймеры, раз в секунду тик, очередь качается.
function harness({ isMod = true, battleFile = null, start = 1_700_000_000_000, seed = 1, adapter: customAdapter } = {}) {
  let t = start;
  const now = () => t;
  const timeouts = [];
  const timers = {
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => { timeouts.push({ at: t + ms, fn, ms }); return timeouts.length; },
    clearTimeout: () => {},
  };
  const logs = { info: [], warn: [], error: [] };
  const log = { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m), addSecret() {} };
  const adapter = customAdapter ?? new FakeAdapter({ now, roles: { broadcaster: false, moderator: isMod, vip: false } });
  adapter.now = now;
  const bot = createBot({
    adapter, config: CONFIG, now, rng: makeRng(seed), log, timers,
    saveToDisk: battleFile !== null, battleFile: battleFile ?? 'unused.json', onConsole: () => {},
  });
  let lastTick = t;
  const runDue = async () => {
    for (const item of timeouts.filter((x) => x.at <= t && !x.done)) {
      item.done = true;
      await item.fn();
    }
  };
  const step = async () => {
    t += 50;
    await runDue();
    if (t - lastTick >= 1000) {
      lastTick = t;
      bot.tickOnce();
    }
    await bot.idle();
    await bot.pumpOnce();
  };
  return {
    bot, adapter, logs, timeouts,
    now,
    advance: (ms) => { t += ms; },
    say: async (userId, text, badges = {}) => { adapter.inject({ userId, displayName: userId, text, badges }); await bot.idle(); },
    run: async (ms) => { for (let i = 0; i < ms / 50; i++) await step(); },
    runUntil: async (pred, maxMs = 30 * 60_000) => { for (let i = 0; i < maxMs / 50 && !pred(); i++) await step(); },
    stop: () => bot.stop({ sleep: async (ms) => { t += ms; await bot.pumpOnce(); } }),
  };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-')), 'battle.json');

test('Последовательность: два сообщения подряд обрабатываются строго по очереди (медленный движок)', async () => {
  const h = harness();
  await h.bot.start();
  const order = [];
  let active = 0;
  let maxActive = 0;
  h.bot.engine.handleMessage = async (event) => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`начало ${event.text}`);
    await new Promise((r) => setTimeout(r, 25)); // «медленный» движок
    order.push(`конец ${event.text}`);
    active--;
    return [];
  };
  h.adapter.inject({ userId: '1', text: '!первое' });
  h.adapter.inject({ userId: '2', text: '!второе' });
  h.bot.tickOnce(); // тик тоже встаёт в ту же очередь
  await h.bot.idle();
  assert.strictEqual(maxActive, 1);
  assert.deepStrictEqual(order, ['начало !первое', 'конец !первое', 'начало !второе', 'конец !второе']);
});

test('Сообщения без «!», свои и повторы messageId не доходят до движка; свои значки задают режим лимитов', async () => {
  const h = harness({ isMod: false });
  await h.bot.start();
  const seen = [];
  const original = h.bot.engine.handleMessage;
  h.bot.engine.handleMessage = (e) => { seen.push(e.text); return original(e); };
  h.adapter.inject({ userId: '1', text: 'привет' });
  h.adapter.inject({ userId: 'nightbot', userLogin: 'nightbot', text: '!join' });
  const r = h.adapter.inject({ userId: '2', text: '!я', messageId: 'same' });
  h.adapter.inject({ userId: '2', text: '!я', messageId: r.messageId }); // повторная доставка
  assert.strictEqual(h.bot.queue.isMod, false);
  h.adapter.inject({ userId: 'bot', text: 'сообщение бота', badges: { vip: '1' } });
  await h.bot.idle();
  assert.deepStrictEqual(seen, ['!я']);
  assert.strictEqual(h.bot.queue.isMod, true, 'бот увидел у себя значок VIP');
  assert.deepStrictEqual(h.bot.stats.ignored, { notCommand: 1, excluded: 1, duplicate: 1, self: 1 });
});

test('Сохранение посреди хода → перезапуск → resume → бой доигрывается', async () => {
  const file = tmpFile();
  const h1 = harness({ battleFile: file });
  await h1.bot.start();
  await h1.say('s', '!босс', STREAMER);
  for (let i = 0; i < 5; i++) await h1.say(`p${i}`, '!join');
  await h1.runUntil(() => h1.bot.engine.getState().turn === 2);
  await h1.run(5000); // середина хода 2
  await h1.stop();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual([saved.state.phase, saved.state.turn], ['running', 2]);

  // «Бот лежал» 3 минуты: окно хода давно истекло.
  const h2 = harness({ battleFile: file, start: h1.now() + 180_000 });
  await h2.bot.start();
  const st = h2.bot.engine.getState();
  assert.deepStrictEqual([st.phase, st.turn], ['running', 2]);
  assert.ok(st.turnEndsAtMs >= h2.now() + 15_000, 'resume дал не меньше 15 с');
  await h2.run(1000);
  assert.strictEqual(h2.adapter.sent[0].text, '🔄 Бот перезапущен, бой продолжается');
  await h2.runUntil(() => h2.bot.engine.getState().phase === 'ended');
  assert.ok(['victory', 'defeat', 'wipe'].includes(h2.bot.engine.getState().result.outcome));
  assert.ok(h2.bot.engine.getState().turn > 2);
});

test('Устаревшее состояние отбрасывается: «Предыдущий бой отменён из-за перезапуска бота»', async () => {
  const file = tmpFile();
  const h1 = harness({ battleFile: file });
  await h1.bot.start();
  await h1.say('s', '!босс', STREAMER);
  await h1.say('p1', '!join');
  await h1.run(2000);
  await h1.stop();
  const h2 = harness({ battleFile: file, start: h1.now() + (T.maxResumeMinutes * 60 + 1) * 1000 });
  await h2.bot.start();
  await h2.run(1000);
  assert.strictEqual(h2.bot.engine.getState().phase, 'idle');
  assert.deepStrictEqual(h2.adapter.sent.map((s) => s.text), ['Предыдущий бой отменён из-за перезапуска бота']);
  assert.ok(!fs.existsSync(file));
});

test('Сквозной бой на 30 игроков: лимит в любом окне 30 с, вступления сводками, high не теряются', async () => {
  for (const isMod of [true, false]) {
    const h = harness({ isMod, seed: 7 });
    await h.bot.start();
    await h.say('s', '!босс', STREAMER);
    for (let i = 0; i < 30; i++) {
      await h.say(`viewer${i}`, '!join');
      await h.run(300); // 30 входов за 9 секунд
    }
    let turn = 0;
    await h.runUntil(() => {
      const st = h.bot.engine.getState();
      if (st.phase === 'running' && st.turn !== turn) {
        turn = st.turn;
        for (let i = 0; i < 30; i += 2) h.adapter.inject({ userId: `viewer${i}`, displayName: `viewer${i}`, text: ['!атака', '!навык', '!особый'][i % 3] });
        h.adapter.inject({ userId: `viewer${turn}`, displayName: `viewer${turn}`, text: '!я' });
      }
      return st.phase === 'ended' && h.bot.queue.length === 0;
    });
    const sent = h.adapter.sent;
    const limit = isMod ? T.limits.mod.perWindow : T.limits.normal.perWindow;
    assert.ok(maxInWindow(sent.map((s) => s.at), 30_000) <= limit);
    const joins = sent.filter((s) => s.text.startsWith('⚔️ В отряд вступили'));
    assert.ok(joins.length >= 1 && joins.length <= 3, `сводок ${joins.length}`);
    assert.strictEqual(sent.filter((s) => s.text.includes('ты в отряде')).length, 0, 'не по сообщению на каждого');
    const last = sent.filter((s) => !s.text.startsWith('🔁')).at(-1); // 🔁 — объявление автобосса после итога
    assert.ok(last.text.startsWith('🏆') || last.text.startsWith('🏃') || last.text.startsWith('💀'), last.text);
    assert.strictEqual(h.bot.queue.stats.byPriority.high.dropped, 0);
    for (const s of sent) assert.ok(s.text.length <= 500);
    assert.deepStrictEqual(h.logs.error, []);
  }
});

test('Нагрузка: 300 игроков за 10 секунд — ни одного исключения, ни одно high не потеряно', async () => {
  for (const spamMe of [false, true]) {
    for (const isMod of [true, false]) {
      const r = await runLoadTest({ players: 300, isMod, spamMe });
      assert.strictEqual(r.joined, 300);
      assert.deepStrictEqual(r.errors, []);
      assert.strictEqual(r.highLost, 0);
      assert.strictEqual(r.byPriority.high.sent, r.byPriority.high.enqueued);
      assert.ok(r.maxIn30s <= r.limit, `${r.maxIn30s} > ${r.limit}`);
      assert.ok(['victory', 'defeat', 'wipe'].includes(r.outcome));
    }
  }
});

test('!ботстатус: только стример и модераторы, не чаще раза в 30 с', async () => {
  const h = harness();
  await h.bot.start();
  await h.say('viewer', '!ботстатус');
  await h.run(500);
  assert.deepStrictEqual(h.adapter.sent, []);
  await h.say('mod', '!БОТСТАТУС', MOD);
  await h.run(500);
  assert.strictEqual(h.adapter.sent.length, 1);
  assert.match(h.adapter.sent[0].text, /^🤖 Бот: аптайм .* \| очередь \d+ \| удалено за сессию 0 \| лимиты: модератор \(85\/30 с\) \| боя нет$/);
  await h.say('s', '!ботстатус', STREAMER);
  await h.run(500);
  assert.strictEqual(h.adapter.sent.length, 1, 'кулдаун 30 с');
  await h.run(30_000);
  await h.say('s', '!ботстатус', STREAMER);
  await h.run(500);
  assert.strictEqual(h.adapter.sent.length, 2);
});

test('Обрыв связи: переподключение 1, 2, 4 … 60 с без ограничения попыток; бой продолжается', async () => {
  class FlakyAdapter extends FakeAdapter {
    constructor(opts) { super(opts); this.failConnects = 0; }
    async connect() {
      if (this.failConnects > 0) {
        this.failConnects--;
        throw new Error('нет сети');
      }
      return super.connect();
    }
  }
  const adapter = new FlakyAdapter({ roles: { moderator: true } });
  const h = harness({ adapter });
  await h.bot.start();
  await h.say('s', '!босс', STREAMER);
  await h.say('p1', '!join');
  await h.runUntil(() => h.bot.engine.getState().phase === 'running');
  const turnBefore = h.bot.engine.getState().turn;

  adapter.failConnects = 8;
  adapter.drop();
  await h.run(5 * 60_000); // 1+2+4+8+16+32+60+60 с неудач и ещё 60 с до успешной попытки
  const delays = h.timeouts.map((x) => x.ms / 1000);
  assert.deepStrictEqual(delays.slice(0, 9), [1, 2, 4, 8, 16, 32, 60, 60, 60]);
  assert.strictEqual(adapter.isConnected, true, 'после 8 неудач подключились');
  assert.ok(h.logs.info.includes('переподключение успешно'));
  assert.ok(h.bot.engine.getState().turn > turnBefore, 'без связи бой шёл дальше');
  const sentBefore = h.adapter.sent.length;
  await h.say('mod', '!ботстатус', MOD);
  await h.run(2000);
  assert.strictEqual(h.adapter.sent.length, sentBefore + 1, 'после возвращения связи сообщения идут');
  assert.ok(h.adapter.sent.at(-1).text.startsWith('🤖 Бот:'));
});

test('Зависший тик пропускается с записью в лог', async () => {
  const h = harness();
  await h.bot.start();
  h.bot.serial.push(() => new Promise(() => {}), 'зависание'); // очередь занята навсегда
  h.bot.tickOnce();
  h.advance(T.tickTimeoutSeconds * 1000);
  h.bot.tickOnce();
  assert.strictEqual(h.bot.stats.tickSkips, 1);
  assert.ok(h.logs.warn.some((m) => m.includes('тик не завершился')));
});

test('Остановка: high успевают уйти, состояние сохранено, соединение закрыто', async () => {
  const file = tmpFile();
  const h = harness({ battleFile: file, isMod: false });
  await h.bot.start();
  for (let i = 0; i < 3; i++) h.bot.queue.enqueue({ text: `важное ${i}`, priority: 'high' });
  await h.stop();
  assert.deepStrictEqual(h.adapter.sent.map((s) => s.text), ['важное 0', 'важное 1', 'важное 2']);
  assert.strictEqual(h.adapter.isConnected, false);
  assert.ok(fs.existsSync(file));
});

test('!поддержатьигру: ссылка на донат любому зрителю, не чаще раза в минуту на весь чат', async () => {
  const h = harness();
  await h.bot.start();
  await h.say('viewer1', '!ПоддержатьИгру');
  await h.run(500);
  assert.deepStrictEqual(h.adapter.sent.map((s) => [s.text, s.priority]), [
    [`💛 Поддержать разработчика игры: ${T.supportUrl}`, 'low'],
  ]);
  assert.match(T.supportUrl, /^https:\/\/www\.donationalerts\.com\/r\/\S+$/);
  await h.say('viewer2', '!поддержатьигру');
  await h.run(500);
  assert.strictEqual(h.adapter.sent.length, 1, 'общий кулдаун: второй зритель в ту же минуту — без ответа');
  await h.run(60_000);
  await h.say('viewer2', '!поддержатьигру');
  await h.run(500);
  assert.strictEqual(h.adapter.sent.length, 2);
});

test('!гайд и !помощь: ссылка на правила для игроков, раз в минуту на весь чат', async () => {
  const h = harness();
  await h.bot.start();
  await h.say('viewer1', '!Гайд');
  await h.run(500);
  assert.deepStrictEqual(h.adapter.sent.map((s) => [s.text, s.priority]), [[`📖 Как играть: ${T.guideUrl}`, 'low']]);
  assert.ok(T.guideUrl.startsWith('https://github.com/') && T.guideUrl.endsWith('#для-игроков'));
  await h.say('viewer2', '!помощь');
  await h.run(500);
  assert.strictEqual(h.adapter.sent.length, 1, 'общий кулдаун на обе команды');
  await h.run(60_000);
  await h.say('viewer2', '!помощь');
  await h.run(500);
  assert.strictEqual(h.adapter.sent.length, 2);
});

test('Автобосс: бот передаёт движку, идёт ли стрим (isLive адаптера)', async () => {
  const h = harness();
  await h.bot.start();
  await h.say('streamer', '!автобосс вкл', { broadcaster: '1' });
  await h.say('streamer', '!босс', { broadcaster: '1' });
  await h.say('u1', '!join');
  await h.run(76_000);
  h.bot.engine.getState().boss.hp = 1;
  h.adapter.live = false; // стрим закончился
  await h.runUntil(() => h.bot.engine.getState().phase === 'ended');
  await h.run(160_000);
  assert.strictEqual(h.bot.engine.getState().phase, 'ended', 'вне стрима новый бой не начинается');
  assert.ok(!h.adapter.sent.some((m) => m.text.startsWith('🔁 Следующий босс')));
  await h.stop();
});
