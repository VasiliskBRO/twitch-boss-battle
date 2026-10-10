import { CONFIG } from './config.js';
import { rand01, pickWeighted } from './rng.js';

export function generateBoss(rng, config = CONFIG) {
  const archetypesKeys = Object.keys(config.ARCHETYPES);
  const archKey = archetypesKeys[rng(0, archetypesKeys.length - 1)];
  const archetype = config.ARCHETYPES[archKey];

  // Name generation
  const genders = ['m', 'f', 'n'];
  const gender = genders[rng(0, genders.length - 1)];
  const noun = archetype.nouns[gender][rng(0, archetype.nouns[gender].length - 1)];
  const adj = archetype.adjectives[gender][rng(0, archetype.adjectives[gender].length - 1)];
  const epithet = archetype.epithets[rng(0, archetype.epithets.length - 1)];
  const name = `${adj} ${noun} ${epithet}`;

  // Weakness and Resistance
  const weaknesses = archetype.potentialWeaknesses;
  const resistances = archetype.potentialResistances;

  let weakness, resistance;
  do {
    weakness = weaknesses[rng(0, weaknesses.length - 1)];
    resistance = resistances[rng(0, resistances.length - 1)];
  } while (weakness === resistance);

  // Skills selection: 4 навыка из пула (без лечения и казни) + лечение пятым + казнь шестой.
  const isHeal = (s) => s.effect === 'heal';
  const pool = archetype.skillPool.filter(s => !isHeal(s) && !s.execute);
  const skills = [];

  const getSkillByKind = (kind) => {
    const filtered = pool.filter(s => s.kind === kind);
    return filtered[rng(0, filtered.length - 1)];
  };

  // 1. Single damage
  skills.push(getSkillByKind('single'));
  // 2. AOE damage
  skills.push(getSkillByKind('aoe'));

  const notPicked = (s) => !skills.some(picked => picked.id === s.id);

  // 3. Random skill (can be debuff/buff/single/aoe)
  const remainingPool = pool.filter(notPicked);
  skills.push(remainingPool[rng(0, remainingPool.length - 1)]);

  // 4. Phase 2+ skill (если все навыки фазы 2+ уже выбраны — любой оставшийся)
  const phase2Pool = pool.filter(s => s.unlockPhase >= 2 && notPicked(s));
  const lastPool = phase2Pool.length > 0 ? phase2Pool : pool.filter(notPicked);
  skills.push(lastPool[rng(0, lastPool.length - 1)]);

  // 5. Лечение (со 2-й фазы; когда его выбирать — см. healWeight)
  const healSkill = archetype.skillPool.find(isHeal);
  if (healSkill) skills.push(healSkill);
  // 6. Казнь (со 2-й фазы)
  const executeSkill = archetype.skillPool.find(s => s.execute);
  if (executeSkill) skills.push(executeSkill);

  return {
    id: `boss_${Date.now()}_${rng(0, 1000)}`,
    name,
    archetype: archKey,
    emoji: archetype.emoji,
    weakness,
    resistance,
    skills,
    hp: 0,
    maxHp: 0,
    hpFinal: false,
    currentPhase: 1,
    statusEffects: [],
    cooldowns: {},
    lastSkillId: null,
    pendingAttack: null,
    // Произведения множителей активных статусов. Множитель архетипа и фаз — в getBossDamageMult.
    damageTakenMult: 1.0,
    damageDealtMult: 1.0,
  };
}

export function finalizeHp(boss, playerCount, rng, config = CONFIG) {
  const { baseHp, perPlayerHp, playerExponent = 1 } = config.BOSS_BASE_STATS;
  const archMult = config.ARCHETYPES[boss.archetype].hpMult;
  // Разброс ×(0.9..1.1) через внедрённый rng (контракт: целое из [min, max]).
  const roll = 0.9 + rand01(rng) * 0.2;
  const calculatedMaxHp = Math.round((baseHp + perPlayerHp * Math.pow(playerCount, playerExponent)) * archMult * roll);

  boss.maxHp = calculatedMaxHp;
  boss.hp = calculatedMaxHp;
  boss.hpFinal = true;
  return boss;
}

// Опции: canKill (false — оставить минимум 1 HP), ignoreResist (множитель не ниже 1.0),
// trueDamage (без слабости, сопротивления и статусов).
// dealt — реально снятое HP (с учётом остатка HP и canKill).
export function applyDamage(boss, amount, damageType, { canKill = true, ignoreResist = false, trueDamage = false } = {}, config = CONFIG) {
  let multiplier = 1.0;

  if (!trueDamage) {
    if (damageType === boss.weakness) multiplier *= 1.5;
    if (damageType === boss.resistance) multiplier *= 0.5;
    // Status modifiers
    multiplier *= boss.damageTakenMult;
    if (ignoreResist) multiplier = Math.max(1.0, multiplier);
  }

  const raw = Math.max(0, Math.round(amount * multiplier));
  const hpBefore = boss.hp;
  boss.hp -= raw;

  if (!canKill && boss.hp <= 0) {
    boss.hp = Math.min(hpBefore, 1);
  } else if (boss.hp < 0) {
    boss.hp = 0;
  }

  const dealt = hpBefore - boss.hp;
  const killed = boss.hp === 0;

  // Phase change logic: сильный удар может пройти несколько порогов сразу (1 → 3).
  let phaseChanged = false;
  const hpPercent = boss.hp / boss.maxHp;

  const thresholds = config.PHASE_THRESHOLDS;
  while (boss.currentPhase <= thresholds.length && hpPercent <= thresholds[boss.currentPhase - 1]) {
    boss.currentPhase++;
    phaseChanged = true;
  }

  return { dealt, multiplier, killed, phaseChanged };
}

// Карта «Смена стихии»: слабость и сопротивление меняются местами, остальное не трогается.
export function swapWeaknessResistance(boss) {
  [boss.weakness, boss.resistance] = [boss.resistance, boss.weakness];
  return boss;
}

export function healBoss(boss, amount) {
  boss.hp = Math.min(boss.maxHp, boss.hp + amount);
}

// Множители пересчитываются из активных статусов: статусы с одним id не складываются
// (действует самый сильный), разные — перемножаются.
function recomputeStatusMults(boss) {
  const strongest = (key) => {
    const byId = new Map();
    for (const s of boss.statusEffects) {
      if (!s[key]) continue;
      const prev = byId.get(s.id);
      if (prev === undefined || Math.abs(s[key] - 1) > Math.abs(prev - 1)) byId.set(s.id, s[key]);
    }
    let m = 1.0;
    for (const v of byId.values()) m *= v;
    return m;
  };
  const taken = strongest('damageTakenMult');
  const dealt = strongest('damageDealtMult');
  boss.damageTakenMult = taken;
  boss.damageDealtMult = dealt;
}

// status: { id, turnsLeft, damageTakenMult, damageDealtMult }. Действует сразу.
export function addStatus(boss, status) {
  boss.statusEffects.push({ ...status });
  recomputeStatusMults(boss);
}

// Снимает все статусы с этим id (Антимагия снимает armor). Возвращает число снятых.
export function removeStatus(boss, id) {
  const before = boss.statusEffects.length;
  boss.statusEffects = boss.statusEffects.filter(s => s.id !== id);
  recomputeStatusMults(boss);
  return before - boss.statusEffects.length;
}

// Вызывается раз в конце хода: уменьшает turnsLeft статусов, истёкшие снимает.
export function tickStatuses(boss) {
  boss.statusEffects = boss.statusEffects.filter(s => {
    s.turnsLeft--;
    return s.turnsLeft > 0;
  });
  recomputeStatusMults(boss);
}

// Вызывается раз в конце хода (вместе с tickStatuses).
export function tickBossCooldowns(boss) {
  for (const id of Object.keys(boss.cooldowns)) {
    if (boss.cooldowns[id] > 0) boss.cooldowns[id]--;
  }
}

// Итоговый множитель урона босса: архетип × фаза × статусы damageDealt.
export function getBossDamageMult(boss, config = CONFIG) {
  const archetype = config.ARCHETYPES[boss.archetype]?.dmgMult ?? 1;
  const phases = config.BOSS_PHASE_DAMAGE_MULT ?? [];
  const phase = phases[boss.currentPhase - 1] ?? phases[phases.length - 1] ?? 1;
  return archetype * phase * boss.damageDealtMult;
}

// Вес лечения: 0 выше BOSS_HEAL_AI.maxHpPct HP, ниже — растёт линейно по мере потери HP.
export function healWeight(boss, config = CONFIG) {
  const { maxHpPct, refHpPct, refWeightMult } = config.BOSS_HEAL_AI;
  const hpPct = boss.maxHp > 0 ? boss.hp / boss.maxHp : 1;
  if (hpPct > maxHpPct) return 0;
  return config.SKILL_WEIGHTS.single * refWeightMult * (maxHpPct - hpPct) / (maxHpPct - refHpPct);
}

export function pickTelegraph(boss, rng, config = CONFIG) {
  const heal = healWeight(boss, config);
  // Лечиться при почти полном HP бессмысленно — такой навык не выбирается вовсе.
  const usable = (s) => s.effect !== 'heal' || heal > 0;
  const availableSkills = boss.skills.filter(s => {
    const cooldown = boss.cooldowns[s.id] || 0;
    const isUnlocked = s.unlockPhase <= boss.currentPhase;
    const notLast = s.id !== boss.lastSkillId;
    return cooldown === 0 && isUnlocked && notLast && usable(s);
  });

  // Лечение — по HP босса; казнь — вес удара в одного × BATTLE.executeWeightMult (босс часто её выбирает).
  const weights = config.SKILL_WEIGHTS;
  const skillWeight = (s) => {
    if (s.effect === 'heal') return heal;
    if (s.execute) return (weights.single ?? 10) * (config.BATTLE.executeWeightMult ?? 1);
    return weights[s.kind] || 10;
  };

  let skill;
  if (availableSkills.length === 0) {
    // Всё на откате: берём разблокированный навык с наименьшим откатом, по возможности не повтор.
    const unlockedAll = boss.skills.filter(s => s.unlockPhase <= boss.currentPhase);
    const unlocked = unlockedAll.some(usable) ? unlockedAll.filter(usable) : unlockedAll;
    const notLast = unlocked.filter(s => s.id !== boss.lastSkillId);
    const pool = notLast.length > 0 ? notLast : unlocked;
    const minCd = Math.min(...pool.map(s => boss.cooldowns[s.id] || 0));
    const soonest = pool.filter(s => (boss.cooldowns[s.id] || 0) === minCd);
    skill = soonest[rng(0, soonest.length - 1)];
  } else {
    // Weighted selection
    skill = pickWeighted(
      availableSkills.map(s => ({ item: s, weight: skillWeight(s) })),
      rand01(rng),
    );
  }

  boss.pendingAttack = skill;
  boss.lastSkillId = skill.id;
  // +1: tickBossCooldowns в конце этого же хода сразу снимет единицу,
  // так что навык недоступен ровно skill.cooldown следующих ходов.
  boss.cooldowns[skill.id] = skill.cooldown + 1;
  return skill;
}

export function toJSON(boss) {
  return JSON.stringify(boss);
}

export function fromJSON(data) {
  const boss = JSON.parse(data);
  // Restore non-serializable things if any.
  return boss;
}
