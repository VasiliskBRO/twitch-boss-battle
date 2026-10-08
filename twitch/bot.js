// Главный цикл бота: адаптер Твича ↔ движок боя ↔ очередь отправки.
// Часы (now), rng, таймеры и хранилище очков внедряются снаружи — так бот одинаково работает
// на настоящем Твиче, в консольном режиме и в тестах на фейковых часах.

import { CONFIG } from '../src/config.js';
import { createBattleEngine, fromJSON } from '../battle/engine.js';
import { createMemoryStore } from '../points/index.js';
import { OutboundQueue } from './outbound_queue.js';
import { normalizeMessage, rolesFromBadges, MessageDeduper, SerialProcessor } from './inbound.js';
import { saveBattle, loadBattle } from './persistence.js';
import { silentLogger } from './logger.js';
import { assertAdapter } from './adapter.js';

const realTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин ${s % 60} с`;
}

export function createBot({
  adapter,
  config = CONFIG,
  now = Date.now,
  rng,
  store = createMemoryStore(),
  log = silentLogger,
  battleFile = config.TWITCH.battleFile,
  saveToDisk = true,
  timers = realTimers,
  timeScale = 1, // консольный режим --fast: интервалы таймеров короче во столько раз
  onConsole = (text) => process.stdout.write(`[консоль] ${text}\n`),
}) {
  assertAdapter(adapter);
  if (typeof rng !== 'function') throw new Error('rng is required');
  const T = config.TWITCH;
  const startedAt = now();

  const stats = { messagesIn: 0, processed: 0, ignored: {}, tickSkips: 0, reconnects: 0, saves: 0 };
  const serial = new SerialProcessor({ log });
  const deduper = new MessageDeduper({ ttlMs: T.dedupeSeconds * 1000, now });
  const queue = new OutboundQueue({
    config: T,
    now,
    log,
    onConsole,
    send: (text, opts) => adapter.send(text, opts),
  });

  queue.setConnected(Boolean(adapter.isConnected)); // до подключения ничего не отправляем
  let engine = createBattleEngine({ config, rng, now, store });
  let statusLastMs = null;
  let lastSaved = { phase: null, turn: null, at: -Infinity };
  let tickRunning = null; // момент начала незавершённого тика
  let intervals = [];
  let reconnectTimer = null;
  let reconnectDelay = T.reconnectInitialSeconds;
  let stopping = false;

  const ignore = (reason) => { stats.ignored[reason] = (stats.ignored[reason] ?? 0) + 1; };
  const enqueueAll = (messages) => { for (const m of messages ?? []) queue.enqueue(m); };

  // ---------- Сохранение ----------

  function save(reason) {
    if (!saveToDisk) return;
    try {
      saveBattle(battleFile, engine.toJSON(), now());
      stats.saves++;
      const st = engine.getState();
      lastSaved = { phase: st.phase, turn: st.turn, at: now() };
      log.info(`сохранение боя (${reason}): фаза ${st.phase}, ход ${st.turn}`);
    } catch (err) {
      log.error(`сохранение боя не удалось: ${err?.message ?? err}`);
    }
  }

  // После каждого хода, при смене фазы и раз в autosaveSeconds во время боя.
  function maybeSave() {
    const st = engine.getState();
    if (st.phase === 'idle') return undefined; // «боя нет» сохранять незачем
    if (st.phase !== lastSaved.phase) return save(`фаза ${st.phase}`);
    if (st.phase === 'running' && st.turn !== lastSaved.turn) return save(`ход ${st.turn}`);
    const active = st.phase === 'lobby' || st.phase === 'running';
    if (active && now() - lastSaved.at >= T.autosaveSeconds * 1000) return save('автосохранение');
    return undefined;
  }

  // Восстановление боя после перезапуска.
  function restore() {
    if (!saveToDisk) return;
    const r = loadBattle(battleFile, now(), T.maxResumeMinutes * 60_000);
    if (r.status === 'resume') {
      engine = fromJSON(r.engineJson, { config, rng, now, store });
      engine.resume(now());
      const st = engine.getState();
      lastSaved = { phase: st.phase, turn: st.turn, at: now() };
      log.info(`бой восстановлен: фаза ${st.phase}, ход ${st.turn}, сохранён ${Math.round((now() - r.savedAtMs) / 1000)} с назад`);
      queue.enqueue({ text: '🔄 Бот перезапущен, бой продолжается', priority: 'high' });
    } else if (r.status === 'stale') {
      log.warn('сохранённый бой устарел и отброшен');
      queue.enqueue({ text: 'Предыдущий бой отменён из-за перезапуска бота', priority: 'normal' });
    } else if (r.status === 'corrupt') {
      log.error('файл боя повреждён, переименован в .corrupt');
    }
  }

  // ---------- Роли бота и режим лимитов ----------

  function updateMode(roles = adapter.selfRoles()) {
    const privileged = Boolean(roles.broadcaster || roles.moderator || roles.vip);
    queue.setMode(privileged);
  }

  // ---------- Входящие ----------

  function botStatus(event) {
    const staff = event.roles.broadcaster || event.roles.moderator;
    if (!staff) return [];
    const t = now();
    if (statusLastMs != null && t - statusLastMs < T.botStatusCooldownSeconds * 1000) return [];
    statusLastMs = t;
    const st = engine.getState();
    const lim = queue.limits;
    const battle = st.phase === 'running' ? `бой идёт, ход ${st.turn}` : { idle: 'боя нет', lobby: 'идёт запись', ended: 'бой окончен' }[st.phase];
    return [{
      text: `🤖 Бот: аптайм ${formatUptime(t - startedAt)} | очередь ${queue.length} | удалено за сессию ${queue.stats.dropped} | лимиты: ${queue.isMod ? 'модератор' : 'обычный'} (${lim.perWindow}/${T.windowSeconds} с) | ${battle}`,
      to: 'chat',
      priority: 'normal',
    }];
  }

  async function processEvent(event) {
    stats.processed++;
    const command = event.text.trim().toLowerCase().split(/\s+/)[0];
    if (command === '!ботстатус') {
      enqueueAll(botStatus(event));
      return;
    }
    enqueueAll(await engine.handleMessage(event)); // await — на случай асинхронного движка
    maybeSave();
  }

  // Вход от адаптера. Возвращает промис обработки (или undefined, если сообщение отброшено).
  function handleRaw(raw) {
    stats.messagesIn++;
    // Свои сообщения не обрабатываем, но по их значкам узнаём роль бота (модератор, VIP).
    if (raw?.userId === adapter.selfUserId) {
      if (raw.badges) {
        const roles = rolesFromBadges(raw.badges);
        if (adapter.updateSelfRoles) adapter.updateSelfRoles(roles);
        else updateMode(roles);
      }
      ignore('self');
      return undefined;
    }
    const { event, reason } = normalizeMessage(raw, { selfUserId: adapter.selfUserId, config: T });
    if (!event) return ignore(reason);
    if (!deduper.check(event.messageId)) return ignore('duplicate');
    return serial.push(() => processEvent(event), 'обработка сообщения');
  }

  // ---------- Тик ----------

  // Раз в секунду. Тик идёт через ту же последовательную очередь, что и сообщения.
  function tickOnce() {
    if (tickRunning !== null) {
      if (now() - tickRunning >= T.tickTimeoutSeconds * 1000) {
        stats.tickSkips++;
        log.warn(`тик не завершился за ${T.tickTimeoutSeconds} с — пропуск`);
      }
      return undefined;
    }
    tickRunning = now();
    return serial.push(async () => {
      enqueueAll(await engine.tick());
      maybeSave();
    }, 'тик').finally(() => { tickRunning = null; });
  }

  // ---------- Соединение ----------

  async function connect() {
    try {
      await adapter.connect();
      reconnectDelay = T.reconnectInitialSeconds;
      updateMode();
      return true;
    } catch (err) {
      log.error(`подключение не удалось: ${err?.message ?? err}`);
      scheduleReconnect();
      return false;
    }
  }

  // Экспоненциальная задержка 1, 2, 4 … 60 с, без ограничения числа попыток.
  function scheduleReconnect() {
    if (stopping || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, T.reconnectMaxSeconds);
    log.warn(`переподключение через ${delay} с`);
    reconnectTimer = timers.setTimeout(async () => {
      reconnectTimer = null;
      stats.reconnects++;
      if (await connect()) log.info('переподключение успешно');
    }, (delay * 1000) / timeScale);
  }

  adapter.onMessage((raw) => handleRaw(raw));
  adapter.onRolesChange((roles) => updateMode(roles));
  adapter.onStatus(({ connected, error }) => {
    queue.setConnected(connected);
    if (connected) {
      log.info('подключено к чату');
    } else {
      log.warn(`соединение потеряно${error ? `: ${error.message}` : ''}`);
      scheduleReconnect();
    }
  });

  // ---------- Запуск и остановка ----------

  async function start() {
    restore();
    await connect();
    intervals.push(timers.setInterval(() => tickOnce(), 1000 / timeScale));
    intervals.push(timers.setInterval(() => { queue.pump(); }, Math.max(10, 50 / timeScale)));
  }

  // SIGINT/SIGTERM: сохранить, успеть отправить high (не дольше shutdownFlushSeconds), отключиться.
  async function stop({ sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms)) } = {}) {
    stopping = true;
    for (const id of intervals) timers.clearInterval(id);
    intervals = [];
    if (reconnectTimer) timers.clearTimeout(reconnectTimer);
    await serial.idle();
    save('остановка');
    const left = await queue.flushHigh({ timeoutMs: T.shutdownFlushSeconds * 1000, sleep });
    if (left > 0) log.warn(`при остановке не успели отправить ${left} сообщений high`);
    try { store.save?.(); } catch (err) { log.error(`сохранение очков: ${err?.message ?? err}`); }
    await adapter.disconnect();
    log.info(`бот остановлен; отправлено ${queue.stats.sent}, удалено ${queue.stats.dropped}`);
  }

  return {
    start,
    stop,
    handleRaw,
    tickOnce,
    pumpOnce: () => queue.pump(),
    idle: () => serial.idle(),
    get engine() { return engine; },
    queue,
    stats,
    serial,
  };
}
