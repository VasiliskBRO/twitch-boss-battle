import { CONFIG } from './config.js';
import { hashKey } from './hash.js';
import { plural, clip, TURN_FORMS } from './text.js';

// Как модификатор сочетается между чертами: mult — перемножение, add — сложение,
// override — значение черты заменяет значение по умолчанию.
const MOD_RULES = {
  maxHpMult: 'mult',
  maxManaMult: 'mult',
  damageMult: 'mult',
  healMult: 'mult',
  damageTakenMult: 'mult',
  critChanceAdd: 'add',
  critChanceOverride: 'override',
  manaRegenPct: 'override',
  manaCostMult: 'mult',
  reviveTurns: 'override',
  missChance: 'add',
  bossTargetWeight: 'mult',
  personalCooldownBonus: 'add',
};

export function defaultMods(config = CONFIG) {
  return {
    maxHpMult: 1,
    maxManaMult: 1,
    damageMult: 1,
    healMult: 1,
    damageTakenMult: 1,
    critChanceAdd: 0,
    critChanceOverride: null,
    manaRegenPct: config.COMBAT.MANA_REGEN_PERCENT,
    manaCostMult: 1,
    reviveTurns: config.COMBAT.DOWNED_TURNS,
    missChance: 0,
    bossTargetWeight: 1,
    personalCooldownBonus: 0,
  };
}

export function getTraitDef(traitId, config = CONFIG) {
  const def = config.TRAITS.find((t) => t.id === traitId);
  if (!def) throw new Error(`Unknown trait: ${traitId}`);
  return def;
}

export function isTraitAllowed(trait, classId) {
  return trait.classes === 'all' || trait.classes.includes(classId);
}

export function combineMods(traitDefs, config = CONFIG) {
  const mods = defaultMods(config);
  for (const def of traitDefs) {
    for (const [key, value] of Object.entries(def.mods)) {
      const rule = MOD_RULES[key];
      if (rule === 'mult') mods[key] *= value;
      else if (rule === 'add') mods[key] += value;
      else if (rule === 'override') mods[key] = value;
      else throw new Error(`Unknown modifier ${key} in trait ${def.id}`);
    }
  }
  return mods;
}

// 1 дар + 2 проклятия из разных групп, допустимые классу игрока (класс уже выдан assignClass).
// Все черты ранжируются по хешу (battleId:userId:traitId), поэтому набор стабилен для пары
// (battleId, userId) и не зависит от общего rng.
export function assignTraits(player, battleId, config = CONFIG) {
  const ranked = config.TRAITS
    .filter((t) => isTraitAllowed(t, player.classId))
    .map((t) => ({ t, score: hashKey(battleId, player.userId, t.id) }))
    .sort((a, b) => a.score - b.score || (a.t.id < b.t.id ? -1 : 1))
    .map((x) => x.t);

  const gift = ranked.find((t) => t.polarity === 'gift');
  if (!gift) throw new Error(`No gift available for class ${player.classId}`);

  const usedGroups = new Set([gift.group]);
  const curses = [];
  for (const t of ranked) {
    if (curses.length === 2) break;
    if (t.polarity === 'curse' && !usedGroups.has(t.group)) {
      curses.push(t.id);
      usedGroups.add(t.group);
    }
  }
  if (curses.length < 2) throw new Error(`Not enough curses for class ${player.classId}`);

  return { gift: gift.id, curses };
}

// Пересчитывает maxHp/maxMana от базы класса, ставит полные HP и ману.
export function applyTraits(player, traits, config = CONFIG) {
  const defs = [traits.gift, ...traits.curses].map((id) => getTraitDef(id, config));
  const cls = config.PLAYER_CLASSES[player.classId];
  player.mods = combineMods(defs, config);
  player.maxHp = Math.round(cls.hp * player.mods.maxHpMult);
  player.maxMana = Math.round(cls.mana * player.mods.maxManaMult);
  player.hp = player.maxHp;
  player.mana = player.maxMana;
  player.traits = { gift: traits.gift, curses: [...traits.curses] };
  return player;
}

const pct = (v) => Math.round(v * 100);
const signedPct = (mult) => {
  const delta = pct(mult - 1);
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`;
};

// Короткая подпись эффекта черты для чата, строится из чисел каталога.
export function describeTrait(def) {
  const m = def.mods;
  const parts = [];
  if ('maxHpMult' in m) parts.push(`${signedPct(m.maxHpMult)} HP`);
  if ('maxManaMult' in m) parts.push(`${signedPct(m.maxManaMult)} маны`);
  if ('damageMult' in m) {
    parts.push(m.healMult === m.damageMult
      ? `${signedPct(m.damageMult)} урона и лечения`
      : `${signedPct(m.damageMult)} урона`);
  } else if ('healMult' in m) {
    parts.push(`${signedPct(m.healMult)} лечения`);
  }
  if ('critChanceAdd' in m) parts.push(`+${pct(m.critChanceAdd)}% к шансу крита`);
  if ('critChanceOverride' in m) parts.push(m.critChanceOverride === 0 ? 'без критов' : `крит ${pct(m.critChanceOverride)}%`);
  if ('manaRegenPct' in m) parts.push(`реген маны ${pct(m.manaRegenPct)}%`);
  if ('reviveTurns' in m) parts.push(`встаёт через ${m.reviveTurns} ${plural(m.reviveTurns, TURN_FORMS)}`);
  if ('manaCostMult' in m) parts.push(`${signedPct(m.manaCostMult)} к цене навыка`);
  if ('damageTakenMult' in m) parts.push(`${signedPct(m.damageTakenMult)} входящего урона`);
  if ('missChance' in m) parts.push(`${pct(m.missChance)}% промахов`);
  if ('bossTargetWeight' in m) parts.push(`босс бьёт ×${m.bossTargetWeight} чаще`);
  if ('personalCooldownBonus' in m) parts.push(`+${m.personalCooldownBonus} ${plural(m.personalCooldownBonus, TURN_FORMS)} к откату особого`);
  return parts.join(', ');
}

// «🎁 Дар: Крепкая шкура (+20% HP) | 💀 Проклятия: Слабая рука (−15% урона и лечения), …» (≤ 250).
export function renderTraits(player, config = CONFIG) {
  if (!player.traits) return '🎁 Черт нет';
  const show = (id) => {
    const def = getTraitDef(id, config);
    return `${def.name} (${describeTrait(def)})`;
  };
  return clip(
    `🎁 Дар: ${show(player.traits.gift)} | 💀 Проклятия: ${player.traits.curses.map(show).join(', ')}`,
    250,
  );
}
