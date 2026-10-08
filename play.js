#!/usr/bin/env node
// Локальная игра в терминале: вы пишете команды как в чате Твича, вокруг сражаются боты.
// Вы одновременно стример (!босс, !карта, !стоп) и игрок (!join, !атака, !навык, !особый, !я).
//
//   node play.js                      — 10 ботов, настоящие тайминги (лобби 75 с, ход 40 с, первый — 60 с)
//   node play.js --bots 20 --fast     — ускоренно: лобби 20 с, ход 10 с, пауза между боями 5 с
//   node play.js --private            — закрытая рука стримера (карты видны как [консоль])
//
// Параметры: --bots N, --lobby S, --turn S, --pause S, --seed N, --name ИМЯ, --fast, --private.
// Очки копятся между запусками в data/points.play.json (!очки, !топ).

import fs from 'node:fs';
import readline from 'node:readline';
import { CONFIG } from './src/config.js';
import { createBattleEngine } from './battle/engine.js';
import { renderPlayerStatus, renderHpBar } from './src/renderer.js';
import { createFileStore } from './points/index.js';

const COMMAND_MIX = [['!атака', 0.5], ['!навык', 0.3], ['!особый', 0.2]];
const BOT_NAMES = ['Ворон', 'Ёжик_TV', 'NightOwl', 'кот_учёный', 'Strelok', 'Магистр', 'ДобрыйДоктор', 'paladin_77',
  'Лиса', 'xXx_Pro_xXx', 'бабушка_Зина', 'Тихоня', 'Gromila', 'Шаман', 'PixelKnight', 'Чай_с_мятой'];

function parseArgs(argv) {
  const a = { bots: 10, lobby: null, turn: null, pause: null, seed: Date.now() % 1_000_000, name: 'Вы', fast: false, private: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--fast') a.fast = true;
    else if (key === '--private') a.private = true;
    else if (['--bots', '--lobby', '--turn', '--pause', '--seed'].includes(key)) a[key.slice(2)] = Number(argv[++i]);
    else if (key === '--name') a.name = argv[++i];
    else throw new Error(`Неизвестный параметр ${key}. См. шапку play.js`);
  }
  return a;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return (min, max) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return min + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max - min + 1));
  };
}

const args = parseArgs(process.argv.slice(2));
const config = {
  ...CONFIG,
  BATTLE: {
    ...CONFIG.BATTLE,
    lobbySeconds: args.lobby ?? (args.fast ? 20 : CONFIG.BATTLE.lobbySeconds),
    turnWindowSeconds: args.turn ?? (args.fast ? 10 : CONFIG.BATTLE.turnWindowSeconds),
    firstTurnWindowSeconds: args.turn ?? (args.fast ? 15 : CONFIG.BATTLE.firstTurnWindowSeconds),
    pauseAfterBattleSeconds: args.pause ?? (args.fast ? 5 : CONFIG.BATTLE.pauseAfterBattleSeconds),
    lobbyProgressSeconds: args.fast ? 8 : CONFIG.BATTLE.lobbyProgressSeconds,
  },
  STREAMER: { ...CONFIG.STREAMER, handVisibility: args.private ? 'private' : 'public' },
};

const ME = { userId: 'me', displayName: args.name, roles: { broadcaster: true, moderator: false } };
fs.mkdirSync('data', { recursive: true });
const store = createFileStore('data/points.play.json');
const engine = createBattleEngine({ config, rng: makeRng(args.seed), now: () => Date.now(), store });
const botRng = makeRng(args.seed ^ 0x5bd1e995);
const bots = Array.from({ length: args.bots }, (_, i) => ({
  userId: `bot${i}`,
  displayName: BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? `_${Math.floor(i / BOT_NAMES.length)}` : ''),
}));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
const isTTY = process.stdout.isTTY;
const gray = (s) => (isTTY ? `\x1b[90m${s}\x1b[0m` : s);
const yellow = (s) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);

function print(lines) {
  if (lines.length === 0) return;
  if (isTTY) process.stdout.write('\r\x1b[K');
  for (const line of lines) console.log(line);
  rl.prompt(true);
}

function show(messages) {
  print(messages.map((m) => (m.to === 'console' ? gray(`[консоль] ${m.text}`) : m.text)));
}

// ---------- Боты ----------
// Расписание: { at: ms, event }. Пересобирается при старте лобби и в начале каждого хода.
let schedule = [];
let seenLobby = null;
let seenTurn = 0;

function planBots() {
  const st = engine.getState();
  const now = Date.now();
  if (st.phase === 'lobby' && seenLobby !== st.battleId) {
    seenLobby = st.battleId;
    seenTurn = 0;
    const span = Math.max(1, config.BATTLE.lobbySeconds * 0.6);
    for (const b of bots) {
      schedule.push({ at: now + botRng(1000, span * 1000), event: { ...b, text: '!join', roles: {} } });
    }
  }
  if (st.phase === 'running' && st.turn !== seenTurn) {
    seenTurn = st.turn;
    const window = config.BATTLE.turnWindowSeconds * 1000;
    for (const b of bots) {
      if (botRng(0, 99) >= 60) continue; // 60% ботов шлют явную команду
      let r = botRng(0, 999) / 1000;
      const cmd = COMMAND_MIX.find(([, w]) => (r -= w) < 0)?.[0] ?? '!атака';
      schedule.push({ at: now + botRng(Math.min(2000, window / 3), Math.max(2000, window - 2000)), event: { ...b, text: cmd, roles: {} } });
    }
  }
}

function runBots() {
  const now = Date.now();
  const due = schedule.filter((s) => s.at <= now);
  schedule = schedule.filter((s) => s.at > now);
  for (const { event } of due) show(engine.handleMessage(event));
}

// ---------- Служебные команды ----------

function status() {
  const st = engine.getState();
  const lines = [yellow(`[фаза: ${st.phase}${st.turn ? `, ход ${st.turn}/${config.BATTLE.maxTurns}` : ''}]`)];
  if (st.boss?.hpFinal) lines.push(yellow(`[босс ${st.boss.name} ${renderHpBar(st.boss)}]`));
  if (st.phase === 'running') lines.push(yellow(`[до конца хода ${Math.max(0, Math.ceil((st.turnEndsAtMs - Date.now()) / 1000))} с]`));
  const me = st.registry.get(ME.userId);
  lines.push(yellow(me ? `[вы] ${renderPlayerStatus(me, config)}` : '[вы не записаны в бой: !join]'));
  const alive = [...st.registry.values()].filter((p) => p.status === 'alive').length;
  if (st.registry.size) lines.push(yellow(`[в отряде ${st.registry.size}, живых ${alive}]`));
  return lines;
}

const HELP = [
  'Команды чата: !босс  !join  !атака  !навык  !особый  !я  !карта N  !рука  !очки  !топ  !стоп',
  'Рука стримера — в конце каждого заголовка хода; полная с описаниями — !рука. Класс при !join случайный.',
  'Служебные: /статус — фаза, таймер и персонаж; /помощь; /выход',
  `Ботов: ${args.bots}. Лобби ${config.BATTLE.lobbySeconds} с, ход ${config.BATTLE.turnWindowSeconds} с, seed ${args.seed}.`,
  'Начните с !босс, затем !join.',
];

print([yellow('🎮 Локальный бой с боссом'), ...HELP.map(yellow)]);

rl.on('line', (line) => {
  const text = line.trim();
  if (text === '/выход' || text === '/exit') return rl.close();
  if (text === '/помощь' || text === '/help') return print(HELP.map(yellow));
  if (text === '/статус' || text === '/status') return print(status());
  if (!text) return rl.prompt();
  const out = engine.handleMessage({ ...ME, text });
  if (out.length === 0 && text.startsWith('!')) print([gray('(ответа нет — как и в чате)')]);
  else show(out);
  planBots();
});

rl.on('close', () => {
  clearInterval(timer);
  const result = engine.getState().result;
  if (result) console.log(yellow(`\nПоследний бой: ${result.outcome}, ходов ${result.turns}.`));
  process.exit(0);
});

const timer = setInterval(() => {
  planBots();
  runBots();
  show(engine.tick());
  planBots();
}, 250);
