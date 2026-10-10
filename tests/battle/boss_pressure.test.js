// Давление босса на большие отряды и ответ чата на его лечение:
// Молитвы не складываются, удар «в одного» бьёт по нескольким целям, хиллер — желанная цель,
// лечение босса сбивается уроном за ход или картой «Прервать».

import test from 'node:test';
import assert from 'node:assert';
import { DET, SKILLS, STREAMER, startBattle, makeRng } from './helpers.js';
import { pickSingleTarget } from '../../src/players.js';
import { renderTurnHeader } from '../../battle/render.js';
import { singleTargetCount } from '../../battle/turn.js';

const HEAL = { id: 't_heal', name: 'Тест-лечение', kind: 'buff', effect: 'heal', power: 0.08, cooldown: 0, unlockPhase: 1 };
const squad = (n, cls) => Array.from({ length: n }, (_, i) => [`${cls}${i}`, cls]);
const hurt = (b) => [...b.st.registry.values()].filter((p) => p.hp < p.maxHp);

test('Молитвы не складываются: каждого лечит одна, вылеченное делится между молившимися', () => {
  const b = startBattle({ players: [['h1', 'хиллер'], ['h2', 'хиллер'], ['w', 'воин']] });
  b.p('w').hp = 20;
  b.say('h1', '!навык');
  b.say('h2', '!навык');
  b.telegraph(SKILLS.armor);
  b.resolve();
  assert.strictEqual(b.p('w').hp, 20 + 18, 'одна Молитва 15% от 120, а не две');
  assert.strictEqual(b.p('h1').stats.healing, 9);
  assert.strictEqual(b.p('h2').stats.healing, 9);
});

test('Удар «в одного»: одна цель на каждые 10 живых бойцов, каждый получает не больше одного удара', () => {
  assert.deepStrictEqual([1, 5, 19, 20, 30, 100].map((n) => singleTargetCount(n, DET)), [1, 1, 1, 2, 3, 10]);

  const big = startBattle({ players: squad(30, 'лучник') });
  big.telegraph(SKILLS.single);
  const msgs = big.resolve();
  assert.strictEqual(hurt(big).length, 3);
  assert.ok(msgs[0].text.includes('«Тест-удар» бьёт 3 целей'), msgs[0].text);

  const small = startBattle({ players: squad(19, 'лучник') });
  small.telegraph(SKILLS.single);
  small.resolve();
  assert.strictEqual(hurt(small).length, 1);
});

test('Удар «в одного» по нескольким целям: провокатор принимает один из ударов', () => {
  const b = startBattle({ players: [['w', 'воин'], ...squad(19, 'лучник')] });
  b.say('w', '!навык');
  b.telegraph(SKILLS.single);
  const msgs = b.resolve();
  assert.strictEqual(hurt(b).length, 2);
  assert.ok(b.p('w').hp < b.p('w').maxHp, 'воин под ударом');
  assert.ok(b.p('w').stats.absorbed > 0);
  assert.ok(msgs[0].text.includes('@w (провокация)'), msgs[0].text);
});

test('Хиллер — желанная цель: вес класса умножается на вес черт', () => {
  const players = [
    { userId: 'h', classId: 'healer', stats: { damage: 0 }, joinedAtTurn: 0, status: 'alive' },
    { userId: 'w', classId: 'warrior', stats: { damage: 0 }, joinedAtTurn: 0, status: 'alive' },
  ];
  const rng = makeRng(5);
  let healer = 0;
  for (let i = 0; i < 6000; i++) if (pickSingleTarget(players, rng, { classWeights: { healer: 2 } }).userId === 'h') healer++;
  assert.ok(Math.abs(healer / 6000 - 2 / 3) < 0.03, `${healer / 6000}`);
});

test('Лечение босса сбивается, если чат за ход нанёс не меньше порога', () => {
  const hit = startBattle({ players: squad(3, 'воин'), bossHp: 1000 });
  hit.st.boss.hp = 500;
  for (const [alias] of squad(3, 'воин')) hit.say(alias, '!атака');
  hit.telegraph(HEAL);
  const msgs = hit.resolve();
  assert.strictEqual(hit.st.boss.hp, 500 - 120, '3 × 40 = 120 = 12% от 1000 — лечение сорвано');
  assert.ok(msgs[0].text.includes('💢 Чат сбил лечение «Тест-лечение»'), msgs[0].text);

  const weak = startBattle({ players: squad(2, 'воин'), bossHp: 1000 });
  weak.st.boss.hp = 500;
  for (const [alias] of squad(2, 'воин')) weak.say(alias, '!атака');
  weak.telegraph(HEAL);
  weak.resolve();
  assert.strictEqual(weak.st.boss.hp, 500 - 80 + 80, '80 урона мало — босс лечится на 8%');
});

test('Заголовок хода с лечением босса показывает порог срыва', () => {
  const state = { turn: 3, boss: { emoji: '🐾', name: 'Тест', hp: 500, maxHp: 1000, currentPhase: 2 }, pendingTelegraph: HEAL };
  const header = renderTurnHeader(state, DET);
  assert.ok(header.includes('💚 Готовит лечение «Тест-лечение»! Собьёте, если нанесёте 120+ урона за ход'), header);
});

test('Карта «Прервать» отменяет действие босса в этом ходу: удар и лечение', () => {
  const b = startBattle({ players: [['w', 'воин'], ['a', 'лучник']] });
  b.giveHand(['interrupt', 'fury', 'fog']);
  b.say('streamer', '!карта 1', STREAMER);
  b.telegraph(SKILLS.aoe);
  const msgs = b.resolve();
  assert.strictEqual(hurt(b).length, 0);
  assert.ok(msgs[0].text.includes('✋ Стример прервал «Тест-волна»'), msgs[0].text);
  b.telegraph(SKILLS.aoe);
  b.resolve();
  assert.strictEqual(hurt(b).length, 2, 'только на один ход');

  const h = startBattle({ players: [['w', 'воин']], bossHp: 1000 });
  h.st.boss.hp = 500;
  h.giveHand(['interrupt', 'fury', 'fog']);
  h.say('streamer', '!карта 1', STREAMER);
  h.telegraph(HEAL);
  h.resolve();
  assert.ok(h.st.boss.hp < 500, 'лечения не было');
});

const EXECUTE = { id: 't_exec', name: 'Тест-казнь', kind: 'single', execute: true, power: 1, cooldown: 0, unlockPhase: 1 };

test('Казнь: валит бойца с полным HP; целей — одна на каждые 6 живых', () => {
  const b = startBattle({ players: squad(12, 'лучник') });
  b.telegraph(EXECUTE);
  const msgs = b.resolve();
  const down = [...b.st.registry.values()].filter((p) => p.status === 'downed');
  assert.strictEqual(down.length, 2);
  assert.ok(msgs[0].text.includes('«Тест-казнь» бьёт 2 целей'), msgs[0].text);

  const one = startBattle({ players: squad(5, 'маг') });
  one.telegraph(EXECUTE);
  one.resolve();
  assert.strictEqual([...one.st.registry.values()].filter((p) => p.status === 'downed').length, 1);
});

test('Казнь отбивается: провокация воина (выживает), Щит и «Прервать» стримера', () => {
  const taunt = startBattle({ players: [['w', 'воин'], ...squad(4, 'лучник')] });
  taunt.say('w', '!навык');
  taunt.telegraph(EXECUTE);
  taunt.resolve();
  assert.strictEqual(taunt.p('w').status, 'alive');
  assert.strictEqual(taunt.p('w').hp, 120 - 60, 'удар 100% HP × 0.5');
  assert.strictEqual(hurt(taunt).length, 1, 'остальные не задеты');

  for (const card of ['shield', 'interrupt']) {
    const b = startBattle({ players: squad(6, 'лучник') });
    b.giveHand([card, 'fury', 'fog']);
    b.say('streamer', '!карта 1', STREAMER);
    b.telegraph(EXECUTE);
    b.resolve();
    assert.strictEqual(hurt(b).length, 0, card);
  }
});

test('Заголовок хода с казнью: сколько бойцов под ударом и как спастись', () => {
  const b = startBattle({ players: squad(12, 'лучник') });
  b.st.pendingTelegraph = EXECUTE;
  const header = renderTurnHeader(b.st, DET);
  assert.ok(header.includes('☠️ Готовит «Тест-казнь» — смертельный удар по 2 бойцам! Воины, !навык — провокация примет удар'), header);
});
