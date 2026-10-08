// Демо хранилища очков: 20 симулированных боёв подряд с одним файловым хранилищем,
// затем вывод !очки и !топ. Файл: data/points.sample.json (+ .bak).
//
//   node demo_points.js

import fs from 'node:fs';
import { CONFIG } from './src/config.js';
import { createBattleEngine } from './battle/engine.js';
import { createFileStore, topTitle } from './points/index.js';

const FILE = 'data/points.sample.json';
const BATTLES = 20;
const VIEWERS = ['Ворон', 'Ёжик_TV', 'NightOwl', 'кот_учёный', 'Strelok', 'Магистр', 'ДобрыйДоктор', 'paladin_77',
  'Лиса', 'xXx_Pro_xXx', 'бабушка_Зина', 'Тихоня', 'Gromila', 'Шаман', 'PixelKnight', 'Чай_с_мятой',
  'Nightbot', 'Кузя', 'Mr_Bean', 'Снежок', 'Барон', 'Ночная_смена', 'Тапок', 'Дед_Мороз'];

function makeRng(seed) {
  let a = seed >>> 0;
  return (min, max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return min + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max - min + 1));
  };
}

fs.mkdirSync('data', { recursive: true });
for (const f of [FILE, `${FILE}.bak`]) if (fs.existsSync(f)) fs.rmSync(f);

let t = 1_760_000_000_000;
const now = () => t;
const rng = makeRng(2026);
const act = makeRng(7);
const store = createFileStore(FILE);
const engine = createBattleEngine({ config: CONFIG, rng, now, store });
const STREAMER = { broadcaster: true, moderator: false };
const say = (i, text) => engine.handleMessage({ userId: `id_${i}`, displayName: VIEWERS[i], text, roles: {} });
const summary = [];

for (let b = 1; b <= BATTLES; b++) {
  engine.handleMessage({ userId: 'streamer', text: '!босс', roles: STREAMER });
  // Приходит 10–18 зрителей; у каждого своя активность (постоянные чаще пишут команды).
  const present = VIEWERS.map((_, i) => i).filter((i) => act(0, 99) < (i < 8 ? 85 : 50)).slice(0, 18);
  for (const i of present) say(i, '!join');
  t += CONFIG.BATTLE.lobbySeconds * 1000;
  engine.tick();
  while (engine.getState().phase === 'running') {
    t += 3000;
    for (const i of present) {
      const activity = i < 8 ? 80 : 35;
      if (act(0, 99) < activity) say(i, ['!атака', '!атака', '!навык', '!особый'][act(0, 3)]);
    }
    const st = engine.getState();
    if (st.streamer.hand.length > 0 && act(0, 1) === 1) {
      engine.handleMessage({ userId: 'streamer', text: `!карта ${act(1, st.streamer.hand.length)}`, roles: STREAMER });
    }
    t = st.turnEndsAtMs;
    engine.tick();
  }
  const r = engine.getState().result;
  summary.push(`  бой ${String(b).padStart(2)}: ${r.outcome.padEnd(7)} ходов ${String(r.turns).padStart(2)}, участников ${r.players.length}`);
  t += CONFIG.BATTLE.pauseAfterBattleSeconds * 1000;
}

console.log(`=== ${BATTLES} БОЁВ ===`);
console.log(summary.join('\n'));

console.log(`\n=== ФАЙЛ ХРАНИЛИЩА: ${FILE} (${fs.statSync(FILE).size} байт, рядом .bak) ===`);
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const leader = store.top(1)[0];
console.log(`Записей: ${Object.keys(data.users).length}, обработанных боёв: ${data.processedBattles.length}. Пример записи (лидер):`);
console.log(JSON.stringify(data.users[leader.userId], null, 2));

console.log('\n=== КОМАНДЫ ===');
t += 120_000;
const show = (i, text) => {
  const out = engine.handleMessage({ userId: `id_${i}`, displayName: VIEWERS[i], text, roles: {} });
  console.log(`> ${VIEWERS[i]}: ${text}`);
  for (const m of out) console.log(`  [${m.text.length}] ${m.text}`);
};
show(0, '!топ');
for (const i of [0, 3, 9, 15]) show(i, '!очки');
show(16, '!очки'); // Nightbot исключён из начислений
show(5, '!топ'); // общий кулдаун 60 с — молчание
console.log('  (ответа нет: общий кулдаун !топ 60 секунд)');

console.log('\n=== ЗВАНИЯ ===');
for (const r of store.top(30)) {
  const title = topTitle(r);
  console.log(`  ${r.displayName.padEnd(14)} ${String(r.totalPoints).padStart(5)} оч. | боёв ${String(r.battles).padStart(2)}, побед ${String(r.wins).padStart(2)}, MVP ${r.mvps}, добиваний ${r.lastHits} | ${title ? title.name : '—'} (${r.titles.length})`);
}
