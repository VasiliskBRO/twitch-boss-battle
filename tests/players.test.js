import test from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../src/config.js';
import {
  createPlayer, joinPlayer, leavePlayer, findMostWounded, pickSingleTarget, resetAll, buildPlayer,
} from '../src/players.js';
import {
  setCommand, clearCommand, rollAction, spendMana, regenMana, takeDamage, healPlayer,
  recordAbsorbed, tickDowned, reviveNow,
} from '../src/player_actions.js';
import { assignElement, assignClass } from '../src/players_utils.js';
import { renderPlayerStatus, renderRoster, renderJoinInfo } from '../src/renderer.js';
import { applyTraits as applyTraitsFor } from '../src/traits.js';
import { makeRng, DRAGON, CLASSES } from './helpers.js';

// Вход через !join: класс случайный (assignClass).
const join = (reg, userId, opts = {}) =>
  joinPlayer(reg, opts.battleId ?? 'b1', userId, opts.name ?? userId, opts.turn ?? 0, opts.started ?? false, { boss: DRAGON });
// Игрок заданного класса (для проверок, где класс важен).
const put = (reg, userId, classId, name = userId) => {
  const p = buildPlayer('b1', userId, name, classId, { boss: DRAGON });
  reg.set(userId, p);
  return p;
};

// Игрок без черт — чтобы проверять чистые числа части 2.
const plain = (classId, userId = 'u1') => createPlayer(userId, userId, classId, 'b1');

test('Статы каждого класса при создании', () => {
  for (const classId of CLASSES) {
    const p = plain(classId);
    const cls = CONFIG.PLAYER_CLASSES[classId];
    assert.deepStrictEqual(
      [p.hp, p.maxHp, p.mana, p.maxMana, p.status],
      [cls.hp, cls.hp, cls.mana, cls.mana, 'alive'],
    );
  }
  assert.deepStrictEqual(
    CLASSES.map((c) => [CONFIG.PLAYER_CLASSES[c].hp, CONFIG.PLAYER_CLASSES[c].mana]),
    [[120, 30], [90, 50], [70, 100], [85, 90]],
  );
});

test('Мана: не выше максимума, восстановление +10%', () => {
  const p = plain('mage');
  p.mana = 10;
  regenMana(p);
  assert.strictEqual(p.mana, 20);
  p.mana = 95;
  regenMana(p);
  assert.strictEqual(p.mana, 100);
  assert.strictEqual(spendMana(p, 40), 40);
  assert.strictEqual(spendMana(p, 1000), 60);
  assert.strictEqual(p.mana, 0);
});

test('Разброс урона в пределах ±15%, доля критов ≈10%', () => {
  const rng = makeRng(7);
  const p = plain('mage');
  let crits = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const a = rollAction(p, 'атака', rng);
    const power = CONFIG.PLAYER_CLASSES.mage.skills.attack.power;
    const base = a.crit ? power * CONFIG.COMBAT.CRIT_MULT : power;
    assert.ok(a.amount >= Math.round(base * 0.85) && a.amount <= Math.round(base * 1.15), `amount ${a.amount}`);
    if (a.crit) crits++;
  }
  assert.ok(Math.abs(crits / N - 0.10) < 0.01, `crit rate ${crits / N}`);
});

test('Меткий выстрел: всегда крит ×2, итого 90 ±15%', () => {
  const rng = makeRng(3);
  const p = plain('archer');
  for (let i = 0; i < 1000; i++) {
    const a = rollAction(p, 'навык', rng);
    assert.strictEqual(a.crit, true);
    assert.strictEqual(a.name, 'Меткий выстрел');
    assert.ok(a.amount >= Math.round(90 * 0.85) && a.amount <= Math.round(90 * 1.15), `amount ${a.amount}`);
  }
});

test('Маг: Шар (100), Воин: Провокация', () => {
  const rng = makeRng(4);
  const mage = plain('mage');
  const a = rollAction(mage, 'навык', rng);
  const base = a.crit ? 100 * 1.5 : 100;
  assert.ok(a.amount >= Math.round(base * 0.85) && a.amount <= Math.round(base * 1.15));
  assert.strictEqual(a.manaCost, 40);

  const w = plain('warrior');
  const t = rollAction(w, 'навык', rng);
  assert.strictEqual(t.kind, 'taunt');
  assert.strictEqual(t.amount, 0.5);
  assert.strictEqual(t.manaCost, 15);
});

test('Дескриптор содержит все поля из ТЗ', () => {
  const a = rollAction(plain('warrior'), 'атака', makeRng(1));
  for (const key of ['kind', 'damageType', 'element', 'amount', 'crit', 'manaCost', 'fallback']) {
    assert.ok(key in a, `missing ${key}`);
  }
});

test('Хиллер: Лечение 35% самого раненого, Молитва 15%, Искра света без маны', () => {
  const rng = makeRng(5);
  const reg = new Map();
  const healer = put(reg, 'h', 'healer');
  const a = put(reg, 'a', 'warrior');
  const b = put(reg, 'b', 'mage');
  a.hp = Math.round(a.maxHp * 0.5);
  b.hp = Math.round(b.maxHp * 0.2);

  assert.strictEqual(findMostWounded(reg, 0, rng), b);

  const p = plain('healer');
  const heal = rollAction(p, 'атака', rng);
  assert.deepStrictEqual([heal.kind, heal.amount, heal.manaCost, heal.fallback], ['heal', 0.35, 10, false]);

  const prayer = rollAction(p, 'навык', rng);
  assert.deepStrictEqual([prayer.kind, prayer.amount, prayer.manaCost], ['healAll', 0.15, 35]);

  p.mana = 5;
  const spark = rollAction(p, 'атака', rng);
  assert.deepStrictEqual([spark.kind, spark.name, spark.damageType, spark.manaCost, spark.fallback], ['damage', 'Искра света', 'holy', 0, true]);
  assert.ok(spark.amount >= Math.round(15 * 0.85) && spark.amount <= Math.round(15 * 1.5 * 1.15));

  // !навык без маны → Лечение, без маны и на него → Искра света
  p.mana = 20;
  assert.strictEqual(rollAction(p, 'навык', rng).kind, 'heal');
  p.mana = 0;
  assert.strictEqual(rollAction(p, 'навык', rng).name, 'Искра света');
  assert.ok(healer);
});

test('Хиллер: перелечивание не считается, при равенстве цель случайная', () => {
  const p = plain('healer');
  p.hp = 80;
  assert.strictEqual(healPlayer(p, 30), 5);

  const reg = new Map();
  for (const id of ['x', 'y', 'z']) put(reg, id, 'warrior');
  const seen = new Set();
  const rng = makeRng(9);
  for (let i = 0; i < 200; i++) seen.add(findMostWounded(reg, 0, rng).userId);
  assert.strictEqual(seen.size, 3);
});

test('!навык без маны заменяется на !атака; автодействие 75% силы', () => {
  const rng = makeRng(11);
  const mage = plain('mage');
  mage.mana = 39;
  const a = rollAction(mage, 'навык', rng);
  assert.deepStrictEqual([a.name, a.fallback, a.manaCost], ['Искра', true, 0]);

  let sum = 0;
  let autoSum = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    sum += rollAction(mage, 'атака', rng).amount;
    autoSum += rollAction(mage, 'навык', rng, { auto: true }).amount;
  }
  assert.ok(Math.abs(autoSum / sum - CONFIG.COMBAT.AUTO_ACTION_POWER) < 0.02, `ratio ${autoSum / sum}`);

  const healer = plain('healer');
  assert.strictEqual(rollAction(healer, 'атака', rng, { auto: true }).amount, 0.35 * CONFIG.COMBAT.AUTO_ACTION_POWER);
});

test('Смерть: упал на ходу t, встал на t+2 с 30% HP; downed не лечится', () => {
  const p = plain('warrior');
  assert.strictEqual(takeDamage(p, 500), 120);
  assert.strictEqual(p.status, 'downed');
  assert.strictEqual(healPlayer(p, 50), 0);
  assert.strictEqual(takeDamage(p, 10), 0);

  assert.strictEqual(tickDowned(p), false); // t+1
  assert.strictEqual(p.status, 'downed');
  assert.strictEqual(tickDowned(p), true); // t+2
  assert.strictEqual(p.status, 'alive');
  assert.strictEqual(p.hp, 36);

  takeDamage(p, 500);
  assert.strictEqual(reviveNow(p, 0.5), true);
  assert.strictEqual(p.hp, 60);
  assert.strictEqual(reviveNow(p, 0.5), false, 'живого не поднимаем');

  recordAbsorbed(p, 12);
  assert.strictEqual(p.stats.absorbed, 12);
});

test('Downed не выбирается целью лечения и атаки босса', () => {
  const reg = new Map();
  const a = put(reg, 'a', 'warrior');
  const b = put(reg, 'b', 'warrior');
  b.hp = 1;
  takeDamage(b, 1000);
  const rng = makeRng(2);
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(findMostWounded(reg, 0, rng), a);
    assert.strictEqual(pickSingleTarget(reg, rng, { turn: 0 }), a);
  }
});

test('Реестр: новичок посреди боя активен со следующего хода, с полным HP', () => {
  const reg = new Map();
  join(reg, 'old');
  const r = join(reg, 'new', { started: true, turn: 5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.player.activeFromTurn, 6);
  assert.strictEqual(r.player.hp, r.player.maxHp);
  const rng = makeRng(1);
  for (let i = 0; i < 50; i++) assert.notStrictEqual(pickSingleTarget(reg, rng, { turn: 5 }).userId, 'new');
});

test('Реестр: один userId — одна запись, повторный !join ничего не меняет', () => {
  const reg = new Map();
  const first = join(reg, 'u1').player;
  const again = join(reg, 'u1', { started: true, turn: 3 });
  assert.deepStrictEqual([again.ok, again.reason, again.player], [true, 'already_joined', first]);
  assert.strictEqual(reg.size, 1);
});

test('Реестр: лимит игроков и resetAll', () => {
  const reg = new Map();
  const config = { ...CONFIG, PLAYER_LIMIT: 3 };
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(joinPlayer(reg, 'b1', `u${i}`, 'n', 0, false, { config }).ok, true);
  }
  const r = joinPlayer(reg, 'b1', 'u9', 'n', 0, false, { config });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'full']);
  resetAll(reg);
  assert.strictEqual(reg.size, 0);
});

test('Последняя команда за ход перезаписывает предыдущие', () => {
  const p = plain('warrior');
  setCommand(p, 'атака', 4);
  setCommand(p, 'навык', 4);
  setCommand(p, 'особый', 4);
  assert.deepStrictEqual(p.lastCommand, { command: 'особый', turn: 4 });
  clearCommand(p);
  assert.strictEqual(p.lastCommand, null);
});

test('Стихия: одна пара (battleId, userId) → одна стихия (1000 повторов)', () => {
  const first = assignElement('battle-42', 'user-7', 'warrior');
  for (let i = 0; i < 1000; i++) assert.strictEqual(assignElement('battle-42', 'user-7', 'warrior'), first);
});

test('Стихия и класс: перезаход их не меняет, хиллер всегда holy', () => {
  for (let i = 0; i < 300; i++) {
    const reg = new Map();
    const id = `user${i}`;
    const { element, classId } = join(reg, id).player;
    if (classId === 'healer') assert.strictEqual(element, 'holy');
    leavePlayer(reg, id);
    const again = join(reg, id, { started: true, turn: 3 }).player;
    assert.deepStrictEqual([again.element, again.classId], [element, classId]);
  }
});

test('Класс: одна пара (battleId, userId) → один класс (1000 повторов)', () => {
  const first = assignClass('battle-42', 'user-7');
  for (let i = 0; i < 1000; i++) assert.strictEqual(assignClass('battle-42', 'user-7'), first);
  const seen = new Set();
  for (let b = 0; b < 50; b++) seen.add(assignClass(`battle${b}`, 'user-7'));
  assert.ok(seen.size > 1, 'в разных боях класс разный');
});

test('Класс: распределение по 10000 userId совпадает с весами ±2%', () => {
  const N = 10000;
  for (const weights of [CONFIG.CLASS_WEIGHTS, { warrior: 10, archer: 20, mage: 30, healer: 40 }]) {
    const config = { ...CONFIG, CLASS_WEIGHTS: weights };
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    const counts = {};
    for (let i = 0; i < N; i++) {
      const c = assignClass('b1', `user${i}`, config);
      counts[c] = (counts[c] || 0) + 1;
    }
    for (const [c, w] of Object.entries(weights)) {
      assert.ok(Math.abs((counts[c] || 0) / N - w / total) < 0.02, `${c}: ${(counts[c] || 0) / N}`);
    }
  }
  assert.strictEqual(assignClass('b1', 'x', { ...CONFIG, CLASS_WEIGHTS: { warrior: 0, archer: 0, mage: 1, healer: 0 } }), 'mage');
});

test('Класс: !join выдаёт класс по assignClass, тот же при перезаходе', () => {
  for (let i = 0; i < 200; i++) {
    const reg = new Map();
    const p = join(reg, `u${i}`).player;
    assert.strictEqual(p.classId, assignClass('b1', `u${i}`));
  }
});

test('Стихия: в разных боях встречаются разные', () => {
  const seen = new Set();
  for (let b = 0; b < 50; b++) seen.add(assignElement(`battle${b}`, 'user1', 'warrior'));
  assert.ok(seen.size > 1);
});

test('Стихия: распределение по 10000 userId совпадает с конфигом ±2%', () => {
  const N = 10000;
  const counts = {};
  for (let i = 0; i < N; i++) {
    const el = assignElement('b1', `user${i}`, 'mage');
    counts[el] = (counts[el] || 0) + 1;
  }
  for (const [el, chance] of Object.entries(CONFIG.ELEMENT_CHANCES)) {
    assert.ok(Math.abs((counts[el] || 0) / N - chance) < 0.02, `${el}: ${(counts[el] || 0) / N}`);
  }
  for (let i = 0; i < N; i++) assert.strictEqual(assignElement('b1', `user${i}`, 'healer'), 'holy');
});

test('Тип урона: воин fire → fire, воин neutral → physical, маг neutral → magic', () => {
  const rng = makeRng(1);
  const w = plain('warrior');
  w.element = 'fire';
  assert.strictEqual(rollAction(w, 'атака', rng).damageType, 'fire');
  w.element = 'neutral';
  assert.strictEqual(rollAction(w, 'атака', rng).damageType, 'physical');
  const m = plain('mage');
  m.element = 'neutral';
  assert.strictEqual(rollAction(m, 'атака', rng).damageType, 'magic');
  assert.strictEqual(rollAction(m, 'навык', rng).damageType, 'magic');
  m.element = 'ice';
  assert.strictEqual(rollAction(m, 'навык', rng).damageType, 'ice');
});

test('renderRoster: склонение для 1, 2, 5, 11, 21', () => {
  const cases = { 1: '1 воин', 2: '2 воина', 5: '5 воинов', 11: '11 воинов', 21: '21 воин' };
  for (const [n, expected] of Object.entries(cases)) {
    const reg = new Map();
    for (let i = 0; i < Number(n); i++) put(reg, `u${i}`, 'warrior');
    assert.strictEqual(renderRoster(reg), `В бой идут: 🛡️ ${expected}`);
  }
  const reg = new Map();
  put(reg, 'a', 'mage');
  put(reg, 'b', 'mage');
  put(reg, 'c', 'healer');
  assert.strictEqual(renderRoster(reg), 'В бой идут: 🔮 2 мага, 💚 1 хиллер');
});

test('renderJoinInfo / renderPlayerStatus: формат, значок стихии, текущие HP и мана', () => {
  const p = put(new Map(), 'u1', 'warrior', 'ник');
  p.element = 'fire';
  p.personalSkill = { skillId: 'counter_strike', rarity: 'rare' };
  applyTraitsFor(p, { gift: 'sturdy', curses: ['weak_hand', 'magnet'] });
  assert.strictEqual(
    renderJoinInfo(p),
    '@ник, ты 🛡️ Воин 🔥 | ❤️ 144/144 | 🔷 30/30 | ✨ Особый: Контрудар (редкий) | 🎁 Дар: Крепкая шкура (+20% HP) | ' +
      '💀 Проклятия: Слабая рука (−15% урона и лечения), Магнит для ударов (босс бьёт ×2 чаще) | !атака !навык !особый',
  );
  p.hp = 84;
  p.mana = 20;
  p.cooldowns.personal = 2;
  p.element = 'neutral';
  assert.ok(renderPlayerStatus(p).startsWith('@ник, ты 🛡️ Воин | ❤️ 84/144 | 🔷 20/30 | ✨ Особый: Контрудар (редкий, откат 2)'));
});

test('renderJoinInfo ≤ 500 символов для всех классов (ник 25 символов, павший, откат)', () => {
  const name = 'x'.repeat(25);
  let longest = 0;
  for (const classId of CLASSES) {
    for (let i = 0; i < 500; i++) {
      const p = buildPlayer('b1', `user${i}`, name, classId, { boss: DRAGON });
      p.status = 'downed';
      p.downedTurnsLeft = 2;
      p.cooldowns.personal = 4;
      const text = renderJoinInfo(p);
      assert.ok(text.length <= 500 && !text.endsWith('…'), text);
      longest = Math.max(longest, text.length);
    }
  }
  assert.ok(longest > 200, `строка содержательная: ${longest}`);
});

test('rollDamageAmount: { amount, crit }, forceCrit и noCrit, damageMult черт', async () => {
  const { rollDamageAmount } = await import('../src/player_actions.js');
  const rng = makeRng(31);
  const p = plain('mage');
  for (let i = 0; i < 2000; i++) {
    const f = rollDamageAmount(p, 100, rng, { forceCrit: true });
    assert.strictEqual(f.crit, true);
    assert.ok(f.amount >= 128 && f.amount <= 173, `forceCrit ${f.amount}`);
    const n = rollDamageAmount(p, 100, rng, { noCrit: true });
    assert.strictEqual(n.crit, false);
    assert.ok(n.amount >= 85 && n.amount <= 115);
  }
  p.mods.damageMult = 2;
  const d = rollDamageAmount(p, 100, rng, { noCrit: true });
  assert.ok(d.amount >= 170 && d.amount <= 230);
});
