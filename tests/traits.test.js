import test from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../src/config.js';
import { createPlayer, joinPlayer, pickSingleTarget, buildPlayer } from '../src/players.js';
import { rollAction, regenMana, takeDamage, tickDowned } from '../src/player_actions.js';
import { assignTraits, applyTraits, getTraitDef, isTraitAllowed, renderTraits } from '../src/traits.js';
import { renderPlayerStatus } from '../src/renderer.js';
import { makeRng, DRAGON, CLASSES } from './helpers.js';

const traitsOf = (classId, userId, battleId = 'b1') => assignTraits({ userId, classId }, battleId);
const withTraits = (classId, traits, userId = 'u1') => applyTraits(createPlayer(userId, userId, classId, 'b1'), traits);
const allIds = (t) => [t.gift, ...t.curses];

test('Ровно 1 дар и 2 проклятия, все из разных групп и допустимы классу (10000 × 4 класса)', () => {
  for (const classId of CLASSES) {
    for (let i = 0; i < 10000; i++) {
      const t = traitsOf(classId, `user${i}`);
      const defs = allIds(t).map((id) => getTraitDef(id));
      assert.strictEqual(defs[0].polarity, 'gift');
      assert.strictEqual(defs[1].polarity, 'curse');
      assert.strictEqual(defs[2].polarity, 'curse');
      assert.strictEqual(new Set(defs.map((d) => d.group)).size, 3, `${classId}/${i}: ${allIds(t)}`);
      for (const d of defs) assert.ok(isTraitAllowed(d, classId), `${d.id} не для ${classId}`);
    }
  }
});

test('У воина нет черт с маной, у хиллера нет черт с критом', () => {
  const manaGroups = new Set(['manaPool', 'manaRegen', 'manaCost']);
  for (let i = 0; i < 10000; i++) {
    for (const id of allIds(traitsOf('warrior', `user${i}`))) assert.ok(!manaGroups.has(getTraitDef(id).group), id);
    for (const id of allIds(traitsOf('healer', `user${i}`))) assert.notStrictEqual(getTraitDef(id).group, 'crit', id);
  }
});

test('Детерминированность: та же пара даёт тот же набор (1000 повторов), в другом бою бывает иначе', () => {
  const first = traitsOf('mage', 'viewer42');
  for (let i = 0; i < 1000; i++) assert.deepStrictEqual(traitsOf('mage', 'viewer42'), first);

  const seen = new Set();
  for (let b = 0; b < 30; b++) seen.add(allIds(traitsOf('mage', 'viewer42', `battle${b}`)).join(','));
  assert.ok(seen.size > 1);
});

test('Черты стабильны для пары (battleId, userId): перезаход через !join их не меняет', () => {
  for (let i = 0; i < 300; i++) {
    const reg = new Map();
    const id = `user${i}`;
    const before = joinPlayer(reg, 'b1', id, id, 0, false, { boss: DRAGON }).player.traits;
    reg.delete(id);
    assert.deepStrictEqual(joinPlayer(reg, 'b1', id, id, 2, true, { boss: DRAGON }).player.traits, before);
  }
});

test('Крепкая шкура ×1.2 и Хрупкий ×0.8 с округлением; вместе не выпадают', () => {
  for (const classId of CLASSES) {
    const base = CONFIG.PLAYER_CLASSES[classId].hp;
    const sturdy = withTraits(classId, { gift: 'sturdy', curses: ['shaky', 'magnet'] });
    assert.strictEqual(sturdy.maxHp, Math.round(base * 1.2));
    assert.strictEqual(sturdy.hp, sturdy.maxHp);
    const frail = withTraits(classId, { gift: 'tenacious', curses: ['frail', 'magnet'] });
    assert.strictEqual(frail.maxHp, Math.round(base * 0.8));
  }
  assert.strictEqual(withTraits('healer', { gift: 'sturdy', curses: ['shaky', 'magnet'] }).maxHp, 102);
  assert.strictEqual(withTraits('mage', { gift: 'mana_pool', curses: ['shaky', 'magnet'] }).maxMana, 130);

  for (const classId of CLASSES) {
    for (let i = 0; i < 10000; i++) {
      const ids = allIds(traitsOf(classId, `user${i}`));
      assert.ok(!(ids.includes('sturdy') && ids.includes('frail')));
    }
  }
});

test('Неудачник обнуляет случайный крит; Меткий глаз +10%', () => {
  const rng = makeRng(21);
  const unlucky = withTraits('mage', { gift: 'sturdy', curses: ['unlucky', 'magnet'] });
  const keen = withTraits('mage', { gift: 'keen_eye', curses: ['shaky', 'magnet'] });
  keen.mods.missChance = 0; // изолируем крит
  let keenCrits = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) {
    assert.strictEqual(rollAction(unlucky, 'атака', rng).crit, false);
    if (rollAction(keen, 'атака', rng).crit) keenCrits++;
  }
  assert.ok(Math.abs(keenCrits / N - 0.20) < 0.02, `keen ${keenCrits / N}`);
  // Гарантированный крит навыка сильнее проклятия (решение по ТЗ).
  const archer = withTraits('archer', { gift: 'sturdy', curses: ['unlucky', 'magnet'] });
  assert.strictEqual(rollAction(archer, 'навык', rng).crit, true);
});

test('Расточитель и Экономный меняют стоимость навыка', () => {
  const rng = makeRng(2);
  const wasteful = withTraits('mage', { gift: 'sturdy', curses: ['wasteful', 'magnet'] });
  const thrifty = withTraits('mage', { gift: 'thrifty', curses: ['frail', 'magnet'] });
  assert.strictEqual(rollAction(wasteful, 'навык', rng).manaCost, 52);
  assert.strictEqual(rollAction(thrifty, 'навык', rng).manaCost, 30);

  wasteful.mana = 45; // хватило бы на обычный Шар (40), но не на 52
  const a = rollAction(wasteful, 'навык', rng);
  assert.deepStrictEqual([a.name, a.fallback], ['Искра', true]);
});

test('Регенерация маны: Быстрое восстановление 15%, Истощение 5%', () => {
  const quick = withTraits('mage', { gift: 'quick_mana', curses: ['frail', 'magnet'] });
  quick.mana = 0;
  regenMana(quick);
  assert.strictEqual(quick.mana, 15);
  const drained = withTraits('mage', { gift: 'sturdy', curses: ['drained', 'magnet'] });
  drained.mana = 0;
  regenMana(drained);
  assert.strictEqual(drained.mana, 5);
});

test('Живучий: возвращение через 1 ход; Толстокожий −15% урона', () => {
  const p = withTraits('warrior', { gift: 'tenacious', curses: ['frail', 'magnet'] });
  takeDamage(p, 1000);
  assert.strictEqual(p.downedTurnsLeft, 1);
  assert.strictEqual(tickDowned(p), true);
  assert.strictEqual(p.status, 'alive');

  const thick = withTraits('warrior', { gift: 'thick_skin', curses: ['frail', 'magnet'] });
  assert.strictEqual(takeDamage(thick, 40), 34);
});

test('Сильная/Слабая рука меняют урон и лечение', () => {
  const strong = withTraits('healer', { gift: 'strong_hand', curses: ['frail', 'magnet'] });
  const weak = withTraits('healer', { gift: 'sturdy', curses: ['weak_hand', 'magnet'] });
  const rng = makeRng(1);
  assert.ok(Math.abs(rollAction(strong, 'атака', rng).amount - 0.35 * 1.15) < 1e-9);
  assert.ok(Math.abs(rollAction(weak, 'атака', rng).amount - 0.35 * 0.85) < 1e-9);
});

test('Дрожащие руки: ≈15% промахов за 10000 бросков, мана тратится', () => {
  const rng = makeRng(13);
  const p = withTraits('mage', { gift: 'sturdy', curses: ['shaky', 'magnet'] });
  let misses = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const a = rollAction(p, 'навык', rng);
    if (a.missed) {
      misses++;
      assert.deepStrictEqual([a.kind, a.amount, a.manaCost], ['none', 0, 40]);
    }
  }
  assert.ok(Math.abs(misses / N - 0.15) < 0.02, `miss ${misses / N}`);
});

test('Магнит для ударов: цель выбирается вдвое чаще (10000 выборов)', () => {
  const rng = makeRng(17);
  const magnet = withTraits('warrior', { gift: 'sturdy', curses: ['magnet', 'shaky'] }, 'm');
  const normal = withTraits('warrior', { gift: 'sturdy', curses: ['frail', 'shaky'] }, 'n');
  let hits = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) if (pickSingleTarget([magnet, normal], rng) === magnet) hits++;
  assert.ok(Math.abs(hits / N - 2 / 3) < 0.02, `magnet share ${hits / N}`);
});

test('pickSingleTarget topDamage: максимум урона, при равенстве случайно', () => {
  const rng = makeRng(5);
  const ps = ['a', 'b', 'c'].map((id) => createPlayer(id, id, 'warrior', 'b1'));
  ps[1].stats.damage = 300;
  for (let i = 0; i < 50; i++) assert.strictEqual(pickSingleTarget(ps, rng, { mode: 'topDamage' }), ps[1]);
  ps[2].stats.damage = 300;
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(pickSingleTarget(ps, rng, { mode: 'topDamage' }).userId);
  assert.deepStrictEqual([...seen].sort(), ['b', 'c']);
});

test('Распределение черт внутри пула каждого класса примерно равномерное (±3%)', () => {
  const N = 10000;
  for (const classId of CLASSES) {
    const gifts = {};
    const curses = {};
    for (let i = 0; i < N; i++) {
      const t = traitsOf(classId, `user${i}`);
      gifts[t.gift] = (gifts[t.gift] || 0) + 1;
      for (const c of t.curses) curses[c] = (curses[c] || 0) + 1;
    }
    const pool = (polarity) => CONFIG.TRAITS.filter((t) => t.polarity === polarity && isTraitAllowed(t, classId));
    for (const [polarity, counts, total] of [['gift', gifts, N], ['curse', curses, 2 * N]]) {
      const ids = pool(polarity).map((t) => t.id);
      for (const id of ids) {
        const share = (counts[id] || 0) / total;
        assert.ok(Math.abs(share - 1 / ids.length) < 0.03, `${classId}/${id}: ${share.toFixed(3)} vs ${(1 / ids.length).toFixed(3)}`);
      }
    }
  }
});

test('renderTraits ≤ 250, renderPlayerStatus ≤ 500 (ники по 25 символов)', () => {
  const p = withTraits('warrior', { gift: 'sturdy', curses: ['weak_hand', 'magnet'] });
  assert.strictEqual(
    renderTraits(p),
    '🎁 Дар: Крепкая шкура (+20% HP) | 💀 Проклятия: Слабая рука (−15% урона и лечения), Магнит для ударов (босс бьёт ×2 чаще)',
  );

  let longest = 0;
  for (const classId of CLASSES) {
    for (let i = 0; i < 1000; i++) {
      const id = `user${i}`;
      const name = `${id}_`.padEnd(25, 'x');
      const player = buildPlayer('b1', id, name, classId, { boss: DRAGON });
      player.cooldowns.personal = 4;
      const traits = renderTraits(player);
      const status = renderPlayerStatus(player);
      assert.ok(traits.length <= 250 && !traits.includes('…'), traits);
      assert.ok(status.length <= 500 && !status.includes('…'), status);
      longest = Math.max(longest, status.length);
    }
  }
  assert.ok(longest < 400, `самый длинный статус ${longest}`);
});
