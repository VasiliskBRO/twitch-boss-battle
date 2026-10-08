import { CONFIG } from './config.js';
import { hashKey } from './hash.js';
import { pickWeighted, rand01 } from './rng.js';
import { plural, clip, TURN_FORMS } from './text.js';
import { playerDamageType } from './players_utils.js';
import { rollAction } from './player_actions.js';
import { defaultMods } from './traits.js';

export function getSkillDef(skillId, config = CONFIG) {
  const def = config.PERSONAL_SKILLS.CATALOG.find((s) => s.id === skillId);
  if (!def) throw new Error(`Unknown personal skill: ${skillId}`);
  return def;
}

export function skillsForClass(classId, config = CONFIG) {
  return config.PERSONAL_SKILLS.CATALOG.filter((s) => s.classId === classId);
}

function ruleMultiplier(rule, boss, player, config) {
  const bossSkills = boss?.skills ?? [];
  let hit;
  switch (rule.type) {
    case 'bossHasKind':
      hit = bossSkills.some((s) => s.kind === rule.kind);
      break;
    case 'bossKindCountAtLeast':
      hit = bossSkills.filter((s) => s.kind === rule.kind).length >= rule.count;
      break;
    case 'bossHasEffect':
      hit = bossSkills.some((s) => s.effect === rule.effect);
      break;
    case 'archetypeIn':
      hit = rule.archetypes.includes(boss?.archetype);
      break;
    case 'resistMatchesPlayerType':
      hit = boss?.resistance != null && boss.resistance === playerDamageType(player, config);
      break;
    default:
      throw new Error(`Unknown weight rule: ${rule.type}`);
  }
  return hit ? rule.mult : rule.elseMult ?? 1;
}

// { skillId: вес } для пула класса игрока: базовый вес × множители правил.
export function getSkillWeights(boss, player, config = CONFIG) {
  const base = config.PERSONAL_SKILLS.BASE_WEIGHT;
  const weights = {};
  for (const skill of skillsForClass(player.classId, config)) {
    weights[skill.id] = skill.weightRules.reduce((w, rule) => w * ruleMultiplier(rule, boss, player, config), base);
  }
  return weights;
}

export function rarityFromRoll(u, config = CONFIG) {
  const entries = Object.entries(config.PERSONAL_SKILLS.RARITIES);
  let cumulative = 0;
  for (const [id, r] of entries) {
    cumulative += r.chance;
    if (u < cumulative) return id;
  }
  return entries[entries.length - 1][0];
}

// Детерминированно по хешу (battleId:userId:соль), без общего rng, из пула класса игрока
// (класс уже выдан assignClass). Перезаход навык и редкость не меняет.
export function assignPersonalSkill(boss, player, battleId, config = CONFIG) {
  const { SALTS } = config.PERSONAL_SKILLS;
  const weights = getSkillWeights(boss, player, config);
  const skillId = pickWeighted(
    Object.entries(weights).map(([item, weight]) => ({ item, weight })),
    hashKey(battleId, player.userId, SALTS.skill),
  );
  const rarity = rarityFromRoll(hashKey(battleId, player.userId, SALTS.rarity), config);
  player.personalSkill = { skillId, rarity };
  player.cooldowns = { ...player.cooldowns, personal: 0 };
  return player.personalSkill;
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => o[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

// Множитель Берсерка: min(cap, 1 + k × доля потерянного HP).
export function berserkMultiplier(lostFraction, { k, cap }) {
  const lost = Math.min(1, Math.max(0, lostFraction));
  return Math.min(cap, 1 + k * lost);
}

// Эффекты навыка с учётом редкости. player задаёт тип урона и HP Берсерка,
// boss — фазу для «Выстрела в слабое место». Без них берутся базовые значения.
export function buildSkillEffects(skillId, rarity, { player = null, boss = null } = {}, config = CONFIG) {
  const def = getSkillDef(skillId, config);
  const r = config.PERSONAL_SKILLS.RARITIES[rarity];
  if (!r) throw new Error(`Unknown rarity: ${rarity}`);

  const effects = structuredClone(def.effects);
  for (const path of def.scale) setPath(effects, path, getPath(effects, path) * r.mult);
  for (const path of def.durations) setPath(effects, path, getPath(effects, path) + r.durationBonus);

  const damageType = player
    ? playerDamageType(player, config)
    : config.PLAYER_CLASSES[def.classId].nativeDamageType;
  for (const e of effects) {
    if ('damageType' in e) e.damageType = damageType;
    if (e.type !== 'damage') continue;
    if (e.scaleByMissingHp && player) {
      e.mult = berserkMultiplier(1 - player.hp / player.maxHp, e.scaleByMissingHp);
    }
    if (e.phaseBonus && boss && boss.currentPhase >= e.phaseBonus.minPhase) {
      e.mult = e.phaseBonus.mult;
    }
  }
  return effects;
}

export function personalCooldownOf(player, config = CONFIG) {
  const rarity = config.PERSONAL_SKILLS.RARITIES[player.personalSkill.rarity];
  return rarity.cooldown + (player.mods ?? defaultMods(config)).personalCooldownBonus;
}

// Контракт для части 5: после применения !особый вызвать startCooldown,
// tickCooldowns — ровно один раз в начале каждого хода. Навык готов при 0.
export function startCooldown(player, config = CONFIG) {
  const value = personalCooldownOf(player, config);
  player.cooldowns = { ...player.cooldowns, personal: value };
  return value;
}

export function tickCooldowns(player) {
  for (const key of Object.keys(player.cooldowns)) {
    if (player.cooldowns[key] > 0) player.cooldowns[key]--;
  }
}

// Дескриптор !особый. Ничего не меняет. На откате — !атака с fallback: true.
// «Дрожащие руки»: missed: true и пустые effects, откат часть 5 всё равно запускает.
export function rollPersonalAction(player, boss, rng, config = CONFIG) {
  if (!player.personalSkill) {
    return rollAction(player, 'особый', rng, {}, config);
  }
  if ((player.cooldowns.personal ?? 0) > 0) {
    return { ...rollAction(player, 'атака', rng, {}, config), fallback: true };
  }

  const { skillId, rarity } = player.personalSkill;
  const mods = player.mods ?? defaultMods(config);
  const missed = mods.missChance > 0 && rand01(rng) < mods.missChance;
  return {
    kind: 'personal',
    skillId,
    name: getSkillDef(skillId, config).name,
    rarity,
    effects: missed ? [] : buildSkillEffects(skillId, rarity, { player, boss }, config),
    fallback: false,
    missed,
  };
}

const FORMATS = {
  // floor, чтобы 62.5% показывалось как 62%; эпсилон гасит ошибки float (0.48 → 48).
  pct: (v) => `${Math.floor(v * 100 + 1e-9)}%`,
  x: (v) => `×${+v.toFixed(2)}`,
  num: (v) => String(+v.toFixed(2)),
  turns: (v) => `${v} ${plural(v, TURN_FORMS)}`,
  hits: (v) => `${v} ${plural(v, ['удар', 'удара', 'ударов'])}`,
};

export function describePersonalSkill(skillId, rarity, config = CONFIG) {
  const def = getSkillDef(skillId, config);
  const effects = buildSkillEffects(skillId, rarity, {}, config);
  return def.text.replace(/\{([^}|]+)\|(\w+)\}/g, (_, path, fmt) => FORMATS[fmt](getPath(effects, path)));
}

// «✨ Особый: Контрудар (редкий): отражает 62% полученного урона. Готов» (≤ 150).
export function renderPersonalSkill(player, config = CONFIG) {
  if (!player.personalSkill) return '✨ Особый: нет';
  const { skillId, rarity } = player.personalSkill;
  const cd = player.cooldowns?.personal ?? 0;
  const state = cd > 0 ? `Откат: ${cd} ${plural(cd, TURN_FORMS)}` : 'Готов';
  const rarityName = config.PERSONAL_SKILLS.RARITIES[rarity].name;
  return clip(
    `✨ Особый: ${getSkillDef(skillId, config).name} (${rarityName}): ${describePersonalSkill(skillId, rarity, config)}. ${state}`,
    150,
  );
}
