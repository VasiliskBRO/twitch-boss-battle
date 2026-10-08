import test from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../src/config.js';
import { createPlayer, joinPlayer } from '../src/players.js';
import {
  getSkillWeights, assignPersonalSkill, buildSkillEffects, berserkMultiplier, rollPersonalAction,
  startCooldown, tickCooldowns, renderPersonalSkill, skillsForClass, getSkillDef,
} from '../src/personal_skills.js';
import { applyTraits } from '../src/traits.js';
import { validateEffect } from '../src/effects.js';
import { makeRng, makeBoss, DRAGON, GOLEM, CLASSES } from './helpers.js';

const RARITIES = Object.keys(CONFIG.PERSONAL_SKILLS.RARITIES);
const player = (classId, element = 'neutral', userId = 'u1') => {
  const p = createPlayer(userId, userId, classId, 'b1');
  p.element = element;
  return p;
};
const withSkill = (classId, skillId, rarity) => {
  const p = player(classId);
  p.personalSkill = { skillId, rarity };
  p.cooldowns.personal = 0;
  return p;
};
const singles = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: 'single' }));

test('Детерминированность: та же тройка → тот же навык и редкость', () => {
  for (const classId of CLASSES) {
    for (let i = 0; i < 200; i++) {
      const a = assignPersonalSkill(DRAGON, player(classId, 'neutral', `user${i}`), 'b1');
      const b = assignPersonalSkill(DRAGON, player(classId, 'neutral', `user${i}`), 'b1');
      assert.deepStrictEqual(a, b);
    }
  }
  const first = assignPersonalSkill(DRAGON, player('mage', 'neutral', 'x'), 'b1');
  for (let i = 0; i < 1000; i++) assert.deepStrictEqual(assignPersonalSkill(DRAGON, player('mage', 'neutral', 'x'), 'b1'), first);
});

test('Навык и черты стабильны для пары (battleId, userId): повторный вход и перезаход их не меняют', () => {
  for (let i = 0; i < 500; i++) {
    const id = `user${i}`;
    const first = joinPlayer(new Map(), 'b1', id, id, 0, false, { boss: DRAGON }).player;
    assert.strictEqual(getSkillDef(first.personalSkill.skillId).classId, first.classId, 'навык из пула своего класса');

    const reg = new Map();
    joinPlayer(reg, 'b1', id, id, 0, false, { boss: DRAGON });
    reg.delete(id); // вышел
    const again = joinPlayer(reg, 'b1', id, id, 3, true, { boss: DRAGON }).player;
    assert.deepStrictEqual([again.classId, again.personalSkill, again.traits], [first.classId, first.personalSkill, first.traits]);
  }
});

test('Редкость по 10000 userId: 70 / 25 / 5 ±2%', () => {
  const N = 10000;
  const counts = { common: 0, rare: 0, epic: 0 };
  for (let i = 0; i < N; i++) counts[assignPersonalSkill(DRAGON, player('warrior', 'neutral', `user${i}`), 'b1').rarity]++;
  for (const [id, r] of Object.entries(CONFIG.PERSONAL_SKILLS.RARITIES)) {
    assert.ok(Math.abs(counts[id] / N - r.chance) < 0.02, `${id}: ${counts[id] / N}`);
  }
});

test('Веса: Антимагия ×3 при бафф-навыках, ×0.3 без них', () => {
  const mage = player('mage');
  assert.strictEqual(getSkillWeights(makeBoss({ skills: [{ kind: 'buff' }] }), mage).antimagic, 30);
  assert.strictEqual(getSkillWeights(makeBoss({ skills: [{ kind: 'single' }] }), mage).antimagic, 3);
});

test('Веса: Очищение ×3 при дебаффах, ×0.3 без них', () => {
  const healer = player('healer', 'holy');
  assert.strictEqual(getSkillWeights(GOLEM, healer).purification, 30);
  assert.strictEqual(getSkillWeights(DRAGON, healer).purification, 3);
});

test('Веса: Ядовитая стрела ×0.3 против нежити, голема, элементаля', () => {
  const archer = player('archer');
  for (const archetype of ['undead', 'golem', 'elemental']) {
    assert.strictEqual(getSkillWeights(makeBoss({ archetype }), archer).poison_arrow, 3);
  }
  for (const archetype of ['beast', 'demon', 'dragon']) {
    assert.strictEqual(getSkillWeights(makeBoss({ archetype }), archer).poison_arrow, 10);
  }
});

test('Веса: Контрудар ×2 при 2+ single; Раскол брони ×2 при armor', () => {
  const w = player('warrior');
  assert.strictEqual(getSkillWeights(makeBoss({ skills: singles(1) }), w).counter_strike, 10);
  assert.strictEqual(getSkillWeights(makeBoss({ skills: singles(2) }), w).counter_strike, 20);
  assert.strictEqual(getSkillWeights(makeBoss({ skills: singles(3) }), w).counter_strike, 20);
  assert.strictEqual(getSkillWeights(makeBoss({ skills: [{ kind: 'buff', effect: 'armor' }] }), w).armor_break, 20);
  assert.strictEqual(getSkillWeights(makeBoss({ skills: [{ kind: 'buff', effect: 'dmg_up' }] }), w).armor_break, 10);
});

test('Веса: Магический барьер ×2, Воскрешение ×3, Щит света ×2 при aoe', () => {
  const aoe = makeBoss({ skills: [{ kind: 'aoe' }] });
  const none = makeBoss({ skills: [{ kind: 'single' }] });
  assert.strictEqual(getSkillWeights(aoe, player('mage')).magic_barrier, 20);
  assert.strictEqual(getSkillWeights(none, player('mage')).magic_barrier, 10);
  assert.strictEqual(getSkillWeights(aoe, player('healer', 'holy')).resurrection, 30);
  assert.strictEqual(getSkillWeights(none, player('healer', 'holy')).resurrection, 10);
  assert.strictEqual(getSkillWeights(aoe, player('healer', 'holy')).light_shield, 20);
  assert.strictEqual(getSkillWeights(none, player('healer', 'holy')).light_shield, 10);
});

test('Веса: компенсатор ×3, когда тип урона игрока = сопротивление босса, иначе ×1', () => {
  const physResist = makeBoss({ resistance: 'physical' });
  const fireResist = makeBoss({ resistance: 'fire' });
  assert.strictEqual(getSkillWeights(physResist, player('warrior', 'neutral')).piercing_strike, 30);
  assert.strictEqual(getSkillWeights(physResist, player('warrior', 'fire')).piercing_strike, 10);
  assert.strictEqual(getSkillWeights(fireResist, player('warrior', 'fire')).piercing_strike, 30);
  assert.strictEqual(getSkillWeights(physResist, player('archer', 'neutral')).armor_piercing_arrow, 30);
  assert.strictEqual(getSkillWeights(makeBoss({ resistance: 'magic' }), player('mage', 'neutral')).spell_break, 30);
  assert.strictEqual(getSkillWeights(makeBoss({ resistance: 'magic' }), player('mage', 'ice')).spell_break, 10);
  assert.strictEqual(getSkillWeights(makeBoss({ resistance: 'ice' }), player('mage', 'ice')).spell_break, 30);
});

test('Частота навыков по 10000 userId = нормализованные веса ±2%', () => {
  const N = 10000;
  for (const boss of [DRAGON, GOLEM]) {
    for (const classId of CLASSES) {
      const observed = {};
      const expected = {};
      for (let i = 0; i < N; i++) {
        const p = createPlayer(`user${i}`, 'n', classId, 'b1'); // стихия по хешу
        const weights = getSkillWeights(boss, p);
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        for (const [id, w] of Object.entries(weights)) expected[id] = (expected[id] || 0) + w / total;
        const { skillId } = assignPersonalSkill(boss, p, 'b1');
        observed[skillId] = (observed[skillId] || 0) + 1;
      }
      for (const id of Object.keys(expected)) {
        const diff = Math.abs((observed[id] || 0) / N - expected[id] / N);
        assert.ok(diff < 0.02, `${boss.archetype}/${classId}/${id}: ${(observed[id] || 0) / N} vs ${expected[id] / N}`);
      }
    }
  }
});

test('Откат: 3 хода, у эпического 2, «Тугодум» +2; на откате fallback на !атака', () => {
  const rng = makeRng(1);
  const p = withSkill('warrior', 'counter_strike', 'common');
  assert.strictEqual(rollPersonalAction(p, DRAGON, rng).kind, 'personal');

  assert.strictEqual(startCooldown(p), 3);
  const fb = rollPersonalAction(p, DRAGON, rng);
  assert.deepStrictEqual([fb.kind, fb.name, fb.fallback], ['damage', 'Удар', true]);
  tickCooldowns(p);
  tickCooldowns(p);
  assert.strictEqual(p.cooldowns.personal, 1);
  assert.strictEqual(rollPersonalAction(p, DRAGON, rng).fallback, true);
  tickCooldowns(p);
  assert.strictEqual(p.cooldowns.personal, 0);
  tickCooldowns(p);
  assert.strictEqual(p.cooldowns.personal, 0, 'не уходит в минус');
  assert.strictEqual(rollPersonalAction(p, DRAGON, rng).kind, 'personal');

  assert.strictEqual(startCooldown(withSkill('warrior', 'counter_strike', 'rare')), 3);
  assert.strictEqual(startCooldown(withSkill('warrior', 'counter_strike', 'epic')), 2);

  const slow = withSkill('warrior', 'counter_strike', 'epic');
  applyTraits(slow, { gift: 'sturdy', curses: ['sluggish', 'magnet'] });
  assert.strictEqual(startCooldown(slow), 4);
});

test('Масштаб по редкости: ×1.0 / ×1.25 / ×1.6, длительности +1 у эпического', () => {
  const pick = (skillId, rarity, path) => path.split('.').reduce((o, k) => o[k], buildSkillEffects(skillId, rarity));
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

  close(pick('counter_strike', 'common', '0.pct'), 0.5);
  close(pick('counter_strike', 'rare', '0.pct'), 0.625);
  close(pick('counter_strike', 'epic', '0.pct'), 0.8);
  close(pick('piercing_strike', 'rare', '0.mult'), 1.5);
  close(pick('piercing_strike', 'epic', '0.mult'), 1.92);
  close(pick('meteor', 'epic', '0.mult'), 5.6);

  assert.deepStrictEqual(RARITIES.map((r) => pick('armor_break', r, '0.turns')), [2, 2, 3]);
  assert.deepStrictEqual(RARITIES.map((r) => pick('poison_arrow', r, '1.turns')), [3, 3, 4]);
  assert.deepStrictEqual(RARITIES.map((r) => pick('blessing', r, '0.turns')), [2, 2, 3]);
  assert.deepStrictEqual(RARITIES.map((r) => pick('purification', r, '0.immunityTurns')), [1, 1, 2]);
  assert.deepStrictEqual(RARITIES.map((r) => pick('meteor', r, '0.delayTurns')), [1, 1, 1], 'задержка Метеора — не длительность');
  assert.deepStrictEqual(RARITIES.map((r) => pick('arrow_rain', r, '0.hits')), [3, 3, 3]);
});

test('Берсерк: ×1 при полном HP, ×5 при минимальном; потолок ×5 у всех; редкие достигают раньше', () => {
  const ks = RARITIES.map((r) => buildSkillEffects('berserk', r)[0].scaleByMissingHp);
  assert.deepStrictEqual(ks.map((s) => s.cap), [5, 5, 5]);

  for (const s of ks) {
    assert.strictEqual(berserkMultiplier(0, s), 1);
    assert.strictEqual(berserkMultiplier(1, s), 5);
  }
  // Минимально возможное HP живого воина — 1.
  for (const rarity of RARITIES) {
    const p = withSkill('warrior', 'berserk', rarity);
    p.hp = 1;
    assert.ok(buildSkillEffects('berserk', rarity, { player: p })[0].mult > 4.9);
    p.hp = p.maxHp;
    assert.strictEqual(buildSkillEffects('berserk', rarity, { player: p })[0].mult, 1);
  }
  // На 80% потерянного HP: обычный ещё не на потолке, редкий и эпический — уже.
  assert.ok(Math.abs(berserkMultiplier(0.8, ks[0]) - 4.2) < 1e-9);
  assert.strictEqual(berserkMultiplier(0.8, ks[1]), 5);
  assert.strictEqual(berserkMultiplier(0.65, ks[2]), 5);
  assert.ok(berserkMultiplier(0.65, ks[1]) < 5);
});

test('Выстрел в слабое место: ×1.5, с фазы 2 ×2.25', () => {
  const p = withSkill('archer', 'weak_spot', 'common');
  assert.strictEqual(buildSkillEffects('weak_spot', 'common', { player: p, boss: makeBoss({ currentPhase: 1 }) })[0].mult, 1.5);
  assert.strictEqual(buildSkillEffects('weak_spot', 'common', { player: p, boss: makeBoss({ currentPhase: 2 }) })[0].mult, 2.25);
  assert.strictEqual(buildSkillEffects('weak_spot', 'common', { player: p, boss: makeBoss({ currentPhase: 3 }) })[0].mult, 2.25);
});

test('Тип урона навыка берётся из стихии игрока', () => {
  const fire = player('warrior', 'fire');
  assert.strictEqual(buildSkillEffects('piercing_strike', 'common', { player: fire })[0].damageType, 'fire');
  assert.strictEqual(buildSkillEffects('piercing_strike', 'common', { player: player('warrior') })[0].damageType, 'physical');
  assert.strictEqual(buildSkillEffects('meteor', 'common', { player: player('mage') })[0].damageType, 'magic');
});

test('Дескрипторы всех 16 навыков × 3 редкостей валидны по EFFECT_TYPES', () => {
  assert.strictEqual(CONFIG.PERSONAL_SKILLS.CATALOG.length, 16);
  for (const classId of CLASSES) assert.strictEqual(skillsForClass(classId).length, 4);

  const rng = makeRng(1);
  for (const def of CONFIG.PERSONAL_SKILLS.CATALOG) {
    for (const rarity of RARITIES) {
      const p = withSkill(def.classId, def.id, rarity);
      p.hp = Math.round(p.maxHp / 2);
      const action = rollPersonalAction(p, makeBoss({ currentPhase: 2 }), rng);
      assert.deepStrictEqual(
        [action.kind, action.skillId, action.rarity, action.fallback, action.missed],
        ['personal', def.id, rarity, false, false],
      );
      assert.ok(action.effects.length > 0);
      for (const e of action.effects) assert.deepStrictEqual(validateEffect(e), [], `${def.id}/${rarity}`);
    }
  }
  assert.notDeepStrictEqual(validateEffect({ type: 'reflect', pct: 2 }), []);
  assert.notDeepStrictEqual(validateEffect({ type: 'nope' }), []);
  assert.notDeepStrictEqual(validateEffect({ type: 'cleanse', immunityTurns: 1, extra: 1 }), []);
});

test('Хиллер никогда не получает компенсатор', () => {
  assert.ok(skillsForClass('healer').every((s) => !s.compensator && !s.weightRules.some((r) => r.type === 'resistMatchesPlayerType')));
  const holyResist = makeBoss({ resistance: 'holy', skills: [{ kind: 'aoe' }, { kind: 'debuff' }] });
  for (let i = 0; i < 2000; i++) {
    const { skillId } = assignPersonalSkill(holyResist, player('healer', 'holy', `user${i}`), 'b1');
    assert.ok(!getSkillDef(skillId).compensator);
  }
});

test('Дрожащие руки: !особый может промахнуться, эффект пустой', () => {
  const rng = makeRng(8);
  const p = withSkill('mage', 'meteor', 'common');
  applyTraits(p, { gift: 'sturdy', curses: ['shaky', 'magnet'] });
  p.personalSkill = { skillId: 'meteor', rarity: 'common' };
  let misses = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const a = rollPersonalAction(p, DRAGON, rng);
    if (a.missed) {
      misses++;
      assert.deepStrictEqual(a.effects, []);
    }
  }
  assert.ok(Math.abs(misses / N - 0.15) < 0.02, `miss rate ${misses / N}`);
});

test('renderPersonalSkill: пример из ТЗ и ≤ 150 символов для всех навыков', () => {
  const p = withSkill('warrior', 'counter_strike', 'rare');
  assert.strictEqual(renderPersonalSkill(p), '✨ Особый: Контрудар (редкий): отражает 62% полученного урона. Готов');
  p.cooldowns.personal = 2;
  assert.strictEqual(renderPersonalSkill(p), '✨ Особый: Контрудар (редкий): отражает 62% полученного урона. Откат: 2 хода');

  for (const def of CONFIG.PERSONAL_SKILLS.CATALOG) {
    for (const rarity of RARITIES) {
      const q = withSkill(def.classId, def.id, rarity);
      q.cooldowns.personal = 4;
      const text = renderPersonalSkill(q);
      assert.ok(text.length <= 150, `${text.length}: ${text}`);
      assert.ok(!text.includes('…'), `обрезано: ${text}`);
    }
  }
  assert.strictEqual(renderPersonalSkill(player('warrior')), '✨ Особый: нет');
});
