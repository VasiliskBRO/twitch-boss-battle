import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../../src/config.js';
import {
  computeContribution, computeAwards, processBattleResult, handleCommand, createMemoryStore, createFileStore,
  checkNewTitles, topTitle, renderAwardsSummary, renderTop, renderMe,
} from '../../points/index.js';

const stats = (s = {}) => ({ damage: 0, healing: 0, absorbed: 0, support: 0, activeTurns: 5, ...s });
const player = (userId, s = {}, displayName = userId) => ({ userId, displayName, classId: 'warrior', stats: stats(s) });
const result = (players, extra = {}) => ({
  battleId: 'b1', outcome: 'victory', turns: 9, bossName: 'Босс', bossArchetype: 'dragon', bossMaxHp: 5000,
  lastHitUserId: null, players, ...extra,
});
const byId = (awards) => Object.fromEntries(awards.map((a) => [a.userId, a]));
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'points-')), 'points.json');

// ---------- Вклад ----------

test('Вклад: веса из конфига; потолок применяется к каждому ходу отдельно', () => {
  assert.strictEqual(computeContribution(stats({ damage: 100, healing: 100, absorbed: 100, support: 100 })), 100 + 180 + 50 + 100);
  assert.strictEqual(computeContribution(stats({ damage: 999, contribution: 42 })), 42, 'итог движка в приоритете');
  const turns = [{ damage: 800 }, { damage: 100 }, { healing: 1000 }];
  // потолок 10% × 5000 = 500 на ход: 500 + 100 + 500
  assert.strictEqual(computeContribution(null, CONFIG, { turns, bossMaxHp: 5000 }), 1100);
  const cfg = { ...CONFIG, POINTS: { ...CONFIG.POINTS, weights: { damage: 2, healing: 0, absorbed: 0, support: 0 } } };
  assert.strictEqual(computeContribution(stats({ damage: 10, healing: 100 }), cfg), 20);
});

// ---------- Награды ----------

test('Участие: только activeTurns ≥ 2; боты из excludeUserIds не получают и не считаются в N', () => {
  const r = result([
    player('a', { damage: 100, activeTurns: 2 }),
    player('b', { damage: 100, activeTurns: 1 }),
    player('nightbot', { damage: 100, activeTurns: 9 }, 'Nightbot'),
    player('12345', { damage: 100, activeTurns: 9 }, 'StreamElements'),
  ]);
  const { awards, participantsCount } = computeAwards(r);
  assert.deepStrictEqual(awards.map((a) => a.userId), ['a']);
  assert.strictEqual(participantsCount, 1);
  assert.strictEqual(byId(awards).a.poolShare, 100, 'пул 100 × N, N = 1');
});

test('Пул: сумма долей = 100 × N; при нулевом вкладе — поровну', () => {
  const players = Array.from({ length: 37 }, (_, i) => player(`u${i}`, { damage: (i * 37) % 101, healing: i % 7 }));
  const { awards } = computeAwards(result(players));
  const exact = awards.reduce((s, a) => s + a.poolShareExact, 0);
  assert.ok(Math.abs(exact - 100 * 37) < 1e-6);
  const floored = awards.reduce((s, a) => s + a.poolShare, 0);
  assert.ok(floored <= 3700 && floored > 3700 - 37);

  const zero = computeAwards(result([player('a'), player('b'), player('c'), player('d')])).awards;
  assert.deepStrictEqual(zero.map((a) => a.poolShare), [100, 100, 100, 100]);
});

test('MVP: больший вклад; при равенстве больше activeTurns, затем раньше присоединился', () => {
  assert.strictEqual(computeAwards(result([player('a', { damage: 10 }), player('b', { damage: 20 })])).mvpUserId, 'b');
  assert.strictEqual(computeAwards(result([
    player('a', { damage: 20, activeTurns: 3 }), player('b', { damage: 20, activeTurns: 7 }),
  ])).mvpUserId, 'b');
  assert.strictEqual(computeAwards(result([
    player('z', { damage: 20, activeTurns: 5 }), player('a', { damage: 20, activeTurns: 5 }),
  ])).mvpUserId, 'z', 'z присоединился раньше');
  const { awards } = computeAwards(result([player('a', { damage: 10 }), player('b', { damage: 30 })]));
  assert.strictEqual(byId(awards).b.mvp, 100);
  assert.strictEqual(byId(awards).a.mvp, 0);
});

test('Добивание: +50 только участнику', () => {
  const players = [player('a', { damage: 10 }), player('b', { damage: 10, activeTurns: 1 })];
  assert.strictEqual(byId(computeAwards(result(players, { lastHitUserId: 'a' })).awards).a.lastHit, 50);
  const notParticipant = computeAwards(result(players, { lastHitUserId: 'b' })).awards;
  assert.ok(notParticipant.every((a) => a.lastHit === 0));
});

test('Поражение ×0.4, отмена ничего не начисляет, минимум 1 очко', () => {
  const players = [player('a', { damage: 30 }), player('b', { damage: 10 })];
  const win = byId(computeAwards(result(players, { lastHitUserId: 'a' })).awards);
  for (const outcome of ['defeat', 'wipe']) {
    const lose = byId(computeAwards(result(players, { outcome, lastHitUserId: 'a' })).awards);
    assert.strictEqual(lose.a.total, Math.floor((50 + 150 + 100 + 50) * 0.4));
    assert.strictEqual(lose.b.total, Math.floor((50 + 50) * 0.4));
  }
  assert.strictEqual(win.a.total, 50 + 150 + 100 + 50);
  assert.deepStrictEqual(computeAwards(result(players, { outcome: 'cancelled' })).awards, []);

  const store = createMemoryStore();
  const r = processBattleResult(result(players, { outcome: 'cancelled' }), store);
  assert.deepStrictEqual([r.skipped, r.messages, store.top(10)], ['cancelled', [], []]);

  const tiny = { ...CONFIG, POINTS: { ...CONFIG.POINTS, participation: 0, poolPerParticipant: 0, mvpBonus: 0 } };
  assert.ok(computeAwards(result(players, { outcome: 'defeat' }), tiny).awards.every((a) => a.total === 1));
});

// ---------- Идемпотентность и запись ----------

test('Идемпотентность: повторный processBattleResult с тем же battleId ничего не меняет', () => {
  const store = createMemoryStore();
  const r = result([player('a', { damage: 30 }), player('b', { damage: 10 })], { lastHitUserId: 'a' });
  processBattleResult(r, store, CONFIG, 1000);
  const before = store.snapshot();
  const again = processBattleResult(r, store, CONFIG, 2000);
  assert.strictEqual(again.skipped, 'duplicate');
  assert.deepStrictEqual(again.messages, []);
  assert.deepStrictEqual(store.snapshot(), before);

  const rec = store.get('a');
  assert.deepStrictEqual(
    [rec.totalPoints, rec.battles, rec.wins, rec.mvps, rec.lastHits, rec.totalDamage, rec.bestBattlePoints],
    [350, 1, 1, 1, 1, 30, 350],
  );
});

test('Хранилище: запись, перезапуск, восстановление из .bak; атомарно без .tmp', () => {
  const file = tmpFile();
  const s1 = createFileStore(file);
  processBattleResult(result([player('a', { damage: 30 }), player('b', { damage: 10 })]), s1, CONFIG, 1000);
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(`${file}.tmp`));

  const s2 = createFileStore(file); // «перезапуск бота»
  assert.deepStrictEqual(s2.get('a'), s1.get('a'));
  assert.strictEqual(s2.isBattleProcessed('b1'), true);

  processBattleResult(result([player('a', { damage: 5 })], { battleId: 'b2' }), s2, CONFIG, 2000);
  assert.ok(fs.existsSync(`${file}.bak`), 'перед перезаписью — копия предыдущей версии');
  const bakPoints = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).users.a.totalPoints;

  fs.writeFileSync(file, '{ повреждено'); // сбой посреди записи
  const s3 = createFileStore(file);
  assert.strictEqual(s3.recoveredFromBackup, true);
  assert.strictEqual(s3.get('a').totalPoints, bakPoints);
  s3.save();
  assert.strictEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).users.a.totalPoints, bakPoints, 'повреждённый файл не затирает .bak');
});

test('Хранилище: отложенная запись (debounce)', async () => {
  const file = tmpFile();
  const store = createFileStore(file, { debounceMs: 30 });
  store.update('x', () => ({ displayName: 'x', totalPoints: 5, firstSeenAt: 1 }));
  store.update('y', () => ({ displayName: 'y', totalPoints: 7, firstSeenAt: 2 }));
  assert.ok(!fs.existsSync(file), 'сразу не пишет');
  await new Promise((r) => setTimeout(r, 80));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(saved.users).sort(), ['x', 'y'], 'одна запись на пачку изменений');
});

// ---------- Звания ----------

test('Звания: пороги, приоритет показа, новые звания не повторяются', () => {
  const rec = { battles: 9, wins: 0, mvps: 0, lastHits: 0, totalHealing: 0, totalSupport: 0, titles: [] };
  assert.deepStrictEqual(checkNewTitles(rec).map((t) => t.id), []);
  rec.battles = 10;
  rec.wins = 5;
  rec.mvps = 1;
  assert.deepStrictEqual(checkNewTitles(rec).map((t) => t.id), ['wins_5', 'mvp_1', 'wins_1', 'battles_10']);
  rec.titles = checkNewTitles(rec).map((t) => t.id);
  assert.strictEqual(topTitle(rec).name, 'Охотник на боссов');
  assert.deepStrictEqual(checkNewTitles(rec), []);
  rec.wins = 40;
  assert.deepStrictEqual(checkNewTitles(rec).map((t) => t.name), ['Убийца драконов', 'Гроза подземелий']);

  // Через бои: звание называется только в бою, где получено.
  const store = createMemoryStore();
  const first = processBattleResult(result([player('a', { damage: 1 })], { battleId: 'x1' }), store);
  assert.deepStrictEqual(first.newTitles.map((t) => t.title.name).sort(), ['Боец', 'Лучший в бою']);
  assert.ok(first.messages[0].text.includes('Новые звания: @a «Боец», «Лучший в бою»') || first.messages[0].text.includes('Новые звания: @a «Лучший в бою», «Боец»'));
  const second = processBattleResult(result([player('a', { damage: 1 })], { battleId: 'x2' }), store);
  assert.deepStrictEqual(second.newTitles, []);
  assert.ok(!second.messages[0].text.includes('Новые звания'));
});

// ---------- Команды ----------

test('!очки и !топ: формат, кулдауны на фейковых часах, новый игрок, равенство в рейтинге', () => {
  const store = createMemoryStore();
  processBattleResult(result([player('a', { damage: 30 }, 'Аня'), player('b', { damage: 10 }, 'Боря')], { battleId: 'c1' }), store, CONFIG, 1000);
  // Позже пришедший игрок с тем же счётом, что у Бори, — ниже.
  store.update('c', () => ({ displayName: 'Вика', totalPoints: store.get('b').totalPoints, battles: 1, wins: 1, mvps: 0, titles: [], firstSeenAt: 5000 }));
  const cd = {};
  const T = 1_000_000;
  const me = handleCommand({ userId: 'a', displayName: 'Аня', text: '!ОЧКИ ' }, store, CONFIG, T, cd);
  assert.strictEqual(me[0].text, `@Аня — Лучший в бою | ${store.get('a').totalPoints} очков (#1 в рейтинге) | боёв 1, побед 1, MVP 1`);
  assert.deepStrictEqual(handleCommand({ userId: 'a', text: '!очки' }, store, CONFIG, T + 29_999, cd), []);
  assert.strictEqual(handleCommand({ userId: 'a', text: '!очки' }, store, CONFIG, T + 30_000, cd).length, 1);
  assert.strictEqual(handleCommand({ userId: 'b', text: '!очки' }, store, CONFIG, T + 1, cd).length, 1, 'кулдаун у каждого свой');
  assert.deepStrictEqual(
    handleCommand({ userId: 'new', displayName: 'Новичок', text: '!очки' }, store, CONFIG, T, cd).map((m) => m.text),
    ['@Новичок, у тебя ещё нет очков: заходи в бой через !join'],
  );

  const top = handleCommand({ userId: 'x', text: '!топ' }, store, CONFIG, T, cd);
  assert.strictEqual(top[0].text, `🏆 Топ чата: 1. @Аня ${store.get('a').totalPoints} · 2. @Боря ${store.get('b').totalPoints} · 3. @Вика ${store.get('c').totalPoints}`);
  assert.deepStrictEqual(handleCommand({ userId: 'y', text: '!топ' }, store, CONFIG, T + 59_999, cd), [], 'общий кулдаун');
  assert.strictEqual(handleCommand({ userId: 'y', text: '!топ' }, store, CONFIG, T + 60_000, cd).length, 1);
  assert.strictEqual(store.rankOf('b'), 2);
  assert.strictEqual(store.rankOf('c'), 3);
  assert.deepStrictEqual(handleCommand({ userId: 'x', text: '!атака' }, store, CONFIG, T, cd), []);
});

test('Длина сообщений ≤ 500 при 500 участниках и очень длинных именах', () => {
  const long = (i) => `user${i}_${'w'.repeat(20)}`;
  const players = Array.from({ length: 500 }, (_, i) => player(`u${i}`, { damage: 1000 - i, activeTurns: 3 }, long(i)));
  const store = createMemoryStore();
  for (const outcome of ['victory', 'defeat']) {
    const r = processBattleResult(result(players, { battleId: `big-${outcome}`, outcome, lastHitUserId: 'u3' }), store);
    for (const m of r.messages) assert.ok(m.text.length <= 500, `${m.text.length}`);
    if (outcome === 'victory') {
      assert.ok(r.newTitles.length >= 500, 'в первом бою у всех новые звания — список обрезается');
      assert.ok(r.messages[0].text.includes(' и ещё '), r.messages[0].text);
    }
  }
  const top = renderTop(store.top(5));
  assert.ok(top.length <= 500);
  assert.ok(renderMe(store.get('u0'), 1).length <= 500);
  const fake = Array.from({ length: 50 }, (_, i) => ({ userId: `t${i}`, displayName: long(i), title: { name: 'Легенда чата' } }));
  const awards = computeAwards(result(players)).awards;
  assert.ok(renderAwardsSummary(result(players), awards, { newTitles: fake, mvpUserId: 'u0' }).length <= 500);
});
