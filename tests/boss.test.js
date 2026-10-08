import test from 'node:test';
import assert from 'node:assert';
import { CONFIG } from '../src/config.js';
import {
  generateBoss,
  finalizeHp,
  applyDamage,
  pickTelegraph,
  toJSON,
  fromJSON,
  tickStatuses,
  addStatus,
  swapWeaknessResistance,
  tickBossCooldowns,
  getBossDamageMult,
  removeStatus
} from '../src/boss.js';
import { renderSpawn } from '../src/renderer.js';
import { makeRng } from './helpers.js';

// Воспроизводимый rng: целое из [min, max] включительно.
const mockRng = makeRng(12345);

// Тип урона без слабости и сопротивления босса — множитель ×1.
const neutralType = (boss) => Object.keys(CONFIG.DAMAGE_TYPES).find(t => t !== boss.weakness && t !== boss.resistance);

test('Boss Generation: Constraints', () => {
  for (let i = 0; i < 100; i++) {
    const boss = generateBoss(mockRng);
    assert.ok(boss.name.length > 0, 'Name should not be empty');
    assert.notStrictEqual(boss.weakness, boss.resistance, 'Weakness should not be same as resistance');
    assert.strictEqual(boss.skills.length, 4, 'Should have 4 skills');

    const hasSingle = boss.skills.some(s => s.kind === 'single');
    const hasAoe = boss.skills.some(s => s.kind === 'aoe');
    assert.ok(hasSingle, 'Should have at least one single damage skill');
    assert.ok(hasAoe, 'Should have at least one AOE skill');

    const spawnMsgs = renderSpawn(boss);
    spawnMsgs.forEach(msg => {
      assert.ok(msg.length <= 500, `Message too long: ${msg}`);
    });
  }
});

test('applyDamage: Multipliers', () => {
  const boss = generateBoss(mockRng);
  boss.maxHp = 1000;
  boss.hp = 1000;

  // Weakness
  const resWeak = applyDamage(boss, 100, boss.weakness);
  assert.strictEqual(resWeak.multiplier, 1.5);
  assert.strictEqual(resWeak.dealt, 150);

  // Resistance
  boss.hp = 1000;
  const resRes = applyDamage(boss, 100, boss.resistance);
  assert.strictEqual(resRes.multiplier, 0.5);
  assert.strictEqual(resRes.dealt, 50);

  // Normal
  const normalType = Object.keys(CONFIG.DAMAGE_TYPES).find(t => t !== boss.weakness && t !== boss.resistance);
  boss.hp = 1000;
  const resNorm = applyDamage(boss, 100, normalType);
  assert.strictEqual(resNorm.multiplier, 1.0);
  assert.strictEqual(resNorm.dealt, 100);
});

test('applyDamage: canKill = false', () => {
  const boss = generateBoss(mockRng);
  boss.hp = 10;
  applyDamage(boss, 100, 'physical', { canKill: false });
  assert.strictEqual(boss.hp, 1, 'Should leave 1 HP when canKill is false');
});

test('Phases: Thresholds', () => {
  const boss = generateBoss(mockRng);
  boss.maxHp = 1000;
  boss.hp = 1000;
  boss.currentPhase = 1;

  // Раньше здесь бился 'physical': если это сопротивление босса, урон делился пополам
  // и фаза не переключалась — тест падал в зависимости от случайного босса.
  const type = neutralType(boss);

  // Phase 1 -> 2 (at 66%)
  applyDamage(boss, 350, type); // hp = 650
  assert.strictEqual(boss.currentPhase, 2, 'Should be phase 2 at 65%');

  // Phase 2 -> 3 (at 33%)
  applyDamage(boss, 400, type); // hp = 250
  assert.strictEqual(boss.currentPhase, 3, 'Should be phase 3 at 25%');
});

test('Phases: один сильный удар проходит несколько порогов', () => {
  for (let i = 0; i < 50; i++) {
    const boss = generateBoss(mockRng);
    boss.maxHp = 1000;
    boss.hp = 1000;
    const res = applyDamage(boss, 800, neutralType(boss)); // 100% → 20%
    assert.strictEqual(boss.currentPhase, 3);
    assert.strictEqual(res.phaseChanged, true);
  }
});

test('Boss Generation: 4 разных навыка, последний — фазы 2+, если такой остался', () => {
  for (let i = 0; i < 2000; i++) {
    const boss = generateBoss(mockRng);
    assert.strictEqual(new Set(boss.skills.map(s => s.id)).size, 4, boss.skills.map(s => s.id).join(','));
    const pool = CONFIG.ARCHETYPES[boss.archetype].skillPool;
    const phase2Left = pool.some(s => s.unlockPhase >= 2 && !boss.skills.slice(0, 3).some(p => p.id === s.id));
    if (phase2Left) assert.ok(boss.skills[3].unlockPhase >= 2);
  }
});

test('finalizeHp: одинаковый rng → одинаковое HP', () => {
  const a = generateBoss(makeRng(7));
  const b = generateBoss(makeRng(7));
  finalizeHp(a, 8, makeRng(99));
  finalizeHp(b, 8, makeRng(99));
  assert.strictEqual(a.maxHp, b.maxHp);
});

test('pickTelegraph: откаты спадают через tickBossCooldowns, навык недоступен ровно cooldown ходов', () => {
  const boss = generateBoss(mockRng);
  boss.currentPhase = 3;
  const used = pickTelegraph(boss, mockRng);
  for (let t = 1; t <= used.cooldown; t++) {
    tickBossCooldowns(boss);
    assert.ok(boss.cooldowns[used.id] > 0, `ход ${t}: ещё на откате`);
  }
  tickBossCooldowns(boss);
  assert.strictEqual(boss.cooldowns[used.id], 0);

  // Длинный бой: навыки не застревают на откате навсегда.
  const seen = new Set();
  for (let t = 0; t < 40; t++) {
    tickBossCooldowns(boss);
    seen.add(pickTelegraph(boss, mockRng).id);
  }
  assert.strictEqual(seen.size, boss.skills.length);
});

test('pickTelegraph: одинаковый rng → одинаковая последовательность атак', () => {
  const run = () => {
    const rng = makeRng(42);
    const boss = generateBoss(rng);
    boss.currentPhase = 3;
    const ids = [];
    for (let t = 0; t < 20; t++) {
      tickBossCooldowns(boss);
      ids.push(pickTelegraph(boss, rng).id);
    }
    return ids.join(',');
  };
  assert.strictEqual(run(), run());
});

test('finalizeHp: Scaling', () => {
  const boss = generateBoss(mockRng);
  const playerCount = 10;
  finalizeHp(boss, playerCount, mockRng);

  const expectedBase = (CONFIG.BOSS_BASE_STATS.baseHp + CONFIG.BOSS_BASE_STATS.perPlayerHp * playerCount) * CONFIG.ARCHETYPES[boss.archetype].hpMult;
  const min = Math.round(expectedBase * 0.9);
  const max = Math.round(expectedBase * 1.1);

  assert.ok(boss.maxHp >= min && boss.maxHp <= max, `HP ${boss.maxHp} out of range [${min}, ${max}]`);
});

test('pickTelegraph: Constraints', () => {
  const boss = generateBoss(mockRng);
  boss.currentPhase = 1;
  finalizeHp(boss, 1, mockRng);

  const skill1 = pickTelegraph(boss, mockRng);
  const skill2 = pickTelegraph(boss, mockRng);

  assert.notStrictEqual(skill1.id, skill2.id, 'Should not pick same skill twice in a row');

  // Test cooldown
  boss.cooldowns = {};
  const skill = pickTelegraph(boss, mockRng);
  const cooldown = boss.cooldowns[skill.id];
  assert.ok(cooldown > 0, 'Skill should have cooldown after being picked');
});

test('Persistence: JSON', () => {
  const boss = generateBoss(mockRng);
  finalizeHp(boss, 5, mockRng);
  boss.currentPhase = 2;
  boss.hp = 500;

  const json = toJSON(boss);
  const restored = fromJSON(json);

  assert.deepStrictEqual(restored, boss, 'Restored boss should be identical to original');
});

test('swapWeaknessResistance: меняет местами и не трогает остальное', () => {
  for (let i = 0; i < 100; i++) {
    const boss = generateBoss(mockRng);
    finalizeHp(boss, 5, mockRng);
    const before = structuredClone(boss);

    assert.strictEqual(swapWeaknessResistance(boss), boss);
    assert.strictEqual(boss.weakness, before.resistance);
    assert.strictEqual(boss.resistance, before.weakness);
    assert.deepStrictEqual({ ...boss, weakness: before.weakness, resistance: before.resistance }, before);

    // Множители урона поменялись вместе с полями.
    boss.hp = boss.maxHp;
    assert.strictEqual(applyDamage(boss, 100, before.weakness).multiplier, 0.5);
    boss.hp = boss.maxHp;
    assert.strictEqual(applyDamage(boss, 100, before.resistance).multiplier, 1.5);

    swapWeaknessResistance(boss);
    assert.deepStrictEqual([boss.weakness, boss.resistance], [before.weakness, before.resistance]);
  }
});

test('Statuses:Modifiers', () => {
  const boss = generateBoss(mockRng);
  boss.damageTakenMult = 1.0;

  addStatus(boss, { id: 'armor', turnsLeft: 2, damageTakenMult: 0.7 });
  tickStatuses(boss);
  assert.strictEqual(boss.damageTakenMult, 0.7, 'Status modifier should apply');

  tickStatuses(boss);
  assert.strictEqual(boss.damageTakenMult, 1.0, 'Status modifier should expire');
});

test('applyDamage: ignoreResist не ниже ×1.0, trueDamage без множителей, dealt = реально снятое HP', () => {
  const boss = generateBoss(mockRng);
  boss.maxHp = 1000;
  boss.hp = 1000;
  assert.strictEqual(applyDamage(boss, 100, boss.resistance, { ignoreResist: true }).dealt, 100);
  boss.hp = 1000;
  assert.strictEqual(applyDamage(boss, 100, boss.weakness, { ignoreResist: true }).dealt, 150, 'слабость сохраняется');
  boss.hp = 1000;
  addStatus(boss, { id: 'armor', turnsLeft: 2, damageTakenMult: 0.7 });
  assert.strictEqual(applyDamage(boss, 100, neutralType(boss), { ignoreResist: true }).dealt, 100);
  boss.hp = 1000;
  assert.strictEqual(applyDamage(boss, 100, boss.weakness, { trueDamage: true }).dealt, 100);
  boss.hp = 30;
  assert.strictEqual(applyDamage(boss, 100, null, { trueDamage: true }).dealt, 30, 'не больше остатка HP');
  boss.hp = 30;
  const r = applyDamage(boss, 100, null, { trueDamage: true, canKill: false });
  assert.deepStrictEqual([r.dealt, boss.hp, r.killed], [29, 1, false]);
});

test('addStatus действует сразу; removeStatus снимает', () => {
  const boss = generateBoss(mockRng);
  boss.maxHp = boss.hp = 1000;
  addStatus(boss, { id: 'vulnerable', turnsLeft: 2, damageTakenMult: 1.25 });
  assert.strictEqual(applyDamage(boss, 100, neutralType(boss)).dealt, 125);
  assert.strictEqual(removeStatus(boss, 'vulnerable'), 1);
  assert.strictEqual(boss.damageTakenMult, 1);
});

test('getBossDamageMult: архетип × фаза × статусы; dmgMult архетипа не теряется после тика', () => {
  const rng = makeRng(3);
  let boss;
  do boss = generateBoss(rng); while (boss.archetype !== 'demon'); // dmgMult 1.2
  assert.ok(Math.abs(getBossDamageMult(boss) - 1.2) < 1e-9);
  tickStatuses(boss);
  assert.ok(Math.abs(getBossDamageMult(boss) - 1.2) < 1e-9, 'регрессия: раньше tickStatuses затирал dmgMult архетипа');
  addStatus(boss, { id: 'fury', turnsLeft: 1, damageDealtMult: 1.5 });
  boss.currentPhase = 3;
  assert.ok(Math.abs(getBossDamageMult(boss) - 1.2 * CONFIG.BOSS_PHASE_DAMAGE_MULT[2] * 1.5) < 1e-9);
  tickStatuses(boss);
  assert.ok(Math.abs(getBossDamageMult(boss) - 1.2 * CONFIG.BOSS_PHASE_DAMAGE_MULT[2]) < 1e-9);
});
