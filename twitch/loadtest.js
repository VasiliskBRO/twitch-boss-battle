// Нагрузочный прогон без Твича: N зрителей заходят в бой за 10 секунд и играют полный бой.
// Всё на фейковых часах (мгновенно), через настоящий бот, очередь и движок, но FakeAdapter.

import { CONFIG } from '../src/config.js';
import { createBot } from './bot.js';
import { FakeAdapter } from './fake_adapter.js';

const noTimers = { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} };
const COMMANDS = ['!атака', '!атака', '!навык', '!особый'];

export function makeRng(seed) {
  let a = seed >>> 0;
  return (min, max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return min + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max - min + 1));
  };
}

// Максимум отправок в любом скользящем окне windowMs.
export function maxInWindow(times, windowMs) {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] >= windowMs) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

// spamMe: все зрители в первом ходу пишут !я — каждому положен ответ, очередь под настоящей нагрузкой.
export async function runLoadTest({ players = 300, isMod = true, seed = 1, config = CONFIG, explicitShare = 0.6, spamMe = false } = {}) {
  let t = 1_700_000_000_000;
  const now = () => t;
  const errors = [];
  const log = { info() {}, warn() {}, error: (m) => errors.push(m), addSecret() {} };
  const adapter = new FakeAdapter({ now, roles: { broadcaster: false, moderator: isMod, vip: false } });
  const bot = createBot({ adapter, config, now, rng: makeRng(seed), log, saveToDisk: false, timers: noTimers, onConsole: () => {} });
  const act = makeRng(seed * 31 + 7);
  await adapter.connect();
  bot.queue.setMode(isMod);

  const say = (userId, text, badges = {}) => {
    try {
      adapter.inject({ userId, displayName: userId, text, badges });
    } catch (err) {
      errors.push(String(err));
    }
  };

  // Сценарий: стример запускает бой, N зрителей заходят в течение 10 секунд.
  say('streamer', '!босс', { broadcaster: '1' });
  const joins = Array.from({ length: players }, (_, i) => ({ at: t + act(0, 9999), userId: `viewer${i}` })).sort((a, b) => a.at - b.at);

  const STEP = 50;
  let lastTick = t;
  let turnSeen = 0;
  let commandsAt = null;
  const deadline = t + 30 * 60_000;
  while (t < deadline) {
    t += STEP;
    while (joins.length && joins[0].at <= t) say(joins.shift().userId, '!join');

    const st = bot.engine.getState();
    if (st.phase === 'running' && st.turn !== turnSeen) {
      turnSeen = st.turn;
      commandsAt = t + 3000;
    }
    if (commandsAt !== null && t >= commandsAt) {
      commandsAt = null;
      for (let i = 0; i < players; i++) if (act(0, 999) < explicitShare * 1000) say(`viewer${i}`, COMMANDS[act(0, 3)]);
      if (st.streamer?.hand.length) say('streamer', `!карта ${act(1, st.streamer.hand.length)}`, { broadcaster: '1' });
      say(`viewer${act(0, players - 1)}`, '!я');
      if (spamMe && st.turn === 1) for (let i = 0; i < players; i++) say(`viewer${i}`, '!я');
    }

    if (t - lastTick >= 1000) {
      lastTick = t;
      bot.tickOnce();
    }
    await bot.idle();
    await bot.pumpOnce();
    if (bot.engine.getState().phase === 'ended' && bot.queue.length === 0) break;
  }

  const q = bot.queue.stats;
  const times = adapter.sent.map((s) => s.at);
  return {
    players,
    spamMe,
    mode: isMod ? 'модератор' : 'обычный',
    outcome: bot.engine.getState().result?.outcome ?? 'не закончен',
    joined: bot.engine.getState().registry.size,
    simulatedSeconds: Math.round((t - 1_700_000_000_000) / 1000),
    sent: adapter.sent.length,
    dropped: q.dropped,
    droppedBy: q.droppedBy,
    byPriority: q.byPriority,
    highLost: q.byPriority.high.dropped,
    maxIn30s: maxInWindow(times, 30_000),
    limit: (isMod ? config.TWITCH.limits.mod : config.TWITCH.limits.normal).perWindow,
    minGapMs: times.slice(1).reduce((m, x, i) => Math.min(m, x - times[i]), Infinity),
    errors,
    joinSummaries: adapter.sent.filter((s) => s.text.startsWith('⚔️ В отряд вступили')).length,
    sentTexts: adapter.sent,
  };
}

export function formatLoadTest(r) {
  const p = r.byPriority;
  return [
    `Нагрузка: ${r.players} зрителей${r.spamMe ? ' (+ все разом пишут !я)' : ''}, режим лимитов «${r.mode}» (лимит ${r.limit} за 30 с), в бою ${r.joined}, исход боя: ${r.outcome}, игрового времени ${r.simulatedSeconds} с`,
    `  Ушло в чат: ${r.sent} сообщений (high ${p.high.sent}/${p.high.enqueued}, normal ${p.normal.sent}/${p.normal.enqueued}, low ${p.low.sent}/${p.low.enqueued})`,
    `  Удалено очередью: ${r.dropped} ${Object.keys(r.droppedBy).length ? JSON.stringify(r.droppedBy) : ''}; потеряно high: ${r.highLost}`,
    `  Максимум за любое окно 30 с: ${r.maxIn30s} (лимит ${r.limit}); минимальный интервал между сообщениями: ${r.minGapMs} мс`,
    `  Сводок «В отряд вступили»: ${r.joinSummaries}; исключений: ${r.errors.length}`,
  ].join('\n');
}
