// Точка входа: node bot.js [--console [--fast]] [--loadtest N]
//   (без флагов)      — бот на настоящем канале Твича (нужны .env и data/tokens.json)
//   --console         — без Твича: пишете в консоль «имя: текст», бот отвечает там же
//   --console --fast  — то же, но игровое время идёт в 10 раз быстрее
//   --loadtest N      — симуляция: N зрителей заходят за 10 секунд и играют полный бой

import fs from 'node:fs';
import readline from 'node:readline';
import { CONFIG } from '../src/config.js';
import { createFileStore } from '../points/index.js';
import { createBot } from './bot.js';
import { FakeAdapter } from './fake_adapter.js';
import { createLogger } from './logger.js';
import { runLoadTest, formatLoadTest, makeRng } from './loadtest.js';
import { parseConsoleLine } from './console_input.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const T = CONFIG.TWITCH;

function seedRng() {
  return makeRng((Date.now() ^ (process.pid << 8)) >>> 0);
}

function installShutdown(bot, log) {
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`получен ${signal}, останавливаюсь`);
    try {
      await bot.stop();
    } catch (err) {
      log.error(`ошибка при остановке: ${err?.stack ?? err}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error(`необработанная ошибка: ${err?.stack ?? err}`));
  return shutdown;
}

// ---------- --loadtest N ----------

async function loadtest() {
  const n = Number(args[args.indexOf('--loadtest') + 1]) || 300;
  console.log(`Симуляция нагрузки: ${n} зрителей, фейковые часы, без Твича…\n`);
  for (const spamMe of [false, true]) {
    for (const isMod of [true, false]) {
      const r = await runLoadTest({ players: n, isMod, spamMe });
      console.log(formatLoadTest(r));
      if (r.errors.length) console.log('  Ошибки:', r.errors.slice(0, 5));
      console.log();
    }
  }
}

// ---------- --console ----------

async function consoleMode() {
  const fast = has('--fast');
  const speed = fast ? 10 : 1;
  const base = Date.now();
  const now = () => base + (Date.now() - base) * speed;
  const log = createLogger({ file: T.logFile, maxBytes: T.logMaxBytes, maxFiles: T.logMaxFiles, now: Date.now });
  const adapter = new FakeAdapter({
    now,
    onSend: (e) => process.stdout.write(`  [чат·${e.priority ?? 'normal'}] ${e.text}\n`),
  });
  // Отдельные файлы, чтобы консольные игры не смешивались с настоящим рейтингом.
  const store = createFileStore('data/points.console.json');
  const bot = createBot({
    adapter, config: CONFIG, now, rng: seedRng(), store, log, timeScale: speed,
    battleFile: 'data/battle.console.json',
    onConsole: (text) => process.stdout.write(`  [консоль] ${text}\n`),
  });
  const shutdown = installShutdown(bot, log);
  await bot.start();

  console.log(`Консольный режим${fast ? ' (время ×10)' : ''}. Формат строк:
  имя: текст            — сообщение зрителя (например «аня: !join»)
  @мод имя: текст       — от модератора
  @стример имя: текст   — от стримера (например «@стример я: !босс»)
  выход                 — остановить бота
Начните с «@стример я: !босс», затем «аня: !join».`);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === 'выход' || text === 'exit') return shutdown('выход');
    const { name, text: msg, badges } = parseConsoleLine(text);
    adapter.inject({ userId: `u_${name.toLowerCase()}`, userLogin: name.toLowerCase(), displayName: name, text: msg, badges });
    return undefined;
  });
  rl.on('close', () => shutdown('конец ввода'));
}

// ---------- Настоящий Твич ----------

async function twitchMode() {
  const dotenv = await import('dotenv');
  dotenv.config({ quiet: true });
  // Client ID: своё приложение из .env или публичное приложение автора игры; секрет — только у своего.
  const clientId = process.env.TWITCH_CLIENT_ID || T.publicClientId;
  const missing = ['TWITCH_CHANNEL', 'BOT_USER_NAME'].filter((k) => !process.env[k]);
  if (!clientId) missing.unshift('TWITCH_CLIENT_ID');
  if (missing.length || !fs.existsSync(T.tokensFile)) {
    console.error('Бот ещё не настроен. Запустите «Установить.bat» (или node setup.js) — это займёт пару минут.');
    if (missing.length) console.error(`   (не хватает: ${missing.join(', ')})`);
    process.exit(1);
  }

  const log = createLogger({ file: T.logFile, maxBytes: T.logMaxBytes, maxFiles: T.logMaxFiles, echo: true });
  log.addSecret(process.env.TWITCH_CLIENT_SECRET);
  const { TwurpleAdapter } = await import('./twurple_adapter.js');
  const adapter = new TwurpleAdapter({
    clientId,
    clientSecret: process.env.TWITCH_CLIENT_SECRET || undefined, // у публичного приложения секрета нет
    channelName: process.env.TWITCH_CHANNEL,
    botUserName: process.env.BOT_USER_NAME,
    tokensFile: T.tokensFile,
    log,
  });
  const store = createFileStore(T.pointsFile);
  if (store.recoveredFromBackup) log.warn(`${T.pointsFile} был повреждён, данные восстановлены из .bak`);
  const bot = createBot({ adapter, config: CONFIG, now: Date.now, rng: seedRng(), store, log, onConsole: (t) => log.info(`[консоль] ${t}`) });
  installShutdown(bot, log);
  log.info(`запуск бота для канала ${process.env.TWITCH_CHANNEL}`);
  await bot.start();
}

if (has('--loadtest')) await loadtest();
else if (has('--console')) await consoleMode();
else await twitchMode();
