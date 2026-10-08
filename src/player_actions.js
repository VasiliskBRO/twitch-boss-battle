import { CONFIG } from './config.js';
import { rand01 } from './rng.js';
import { playerDamageType } from './players_utils.js';
import { defaultMods } from './traits.js';

// Последняя команда за ход побеждает: каждый вызов перезаписывает предыдущую.
export function setCommand(player, command, turn) {
  player.lastCommand = { command, turn };
}

export function clearCommand(player) {
  player.lastCommand = null;
}

function modsOf(player, config) {
  return player.mods ?? defaultMods(config);
}

export function manaCostOf(player, ability, config = CONFIG) {
  return Math.round(ability.manaCost * modsOf(player, config).manaCostMult);
}

export function critChanceOf(player, config = CONFIG) {
  const mods = modsOf(player, config);
  return mods.critChanceOverride ?? config.COMBAT.CRIT_CHANCE + mods.critChanceAdd;
}

// !навык без маны → !атака; у хиллера !атака без маны → Искра света.
function resolveAbility(player, command, config) {
  const skills = config.PLAYER_CLASSES[player.classId].skills;
  let ability = command === 'навык' ? skills.skill : skills.attack;
  let fallback = false;
  if (ability === skills.skill && player.mana < manaCostOf(player, ability, config)) {
    ability = skills.attack;
    fallback = true;
  }
  if (skills.fallbackAttack && player.mana < manaCostOf(player, ability, config)) {
    ability = skills.fallbackAttack;
    fallback = true;
  }
  return { ability, fallback };
}

// Дескриптор действия для !атака / !навык. Ничего не меняет — применяет часть 5.
//   kind: damage | heal | healAll | taunt | none
//   amount: damage — урон; heal/healAll — доля макс. HP цели; taunt — множитель урона по воину
//   missed: «Дрожащие руки» — kind 'none', amount 0, но manaCost сохраняется (мана тратится)
// !особый обрабатывает rollPersonalAction (src/personal_skills.js).
export function rollAction(player, command, rng, { auto = false } = {}, config = CONFIG) {
  if (command === 'особый') {
    return {
      kind: 'none', name: null, damageType: null, element: player.element, amount: 0, crit: false,
      manaCost: 0, fallback: false, missed: false,
      reason: player.personalSkill ? 'use_rollPersonalAction' : 'нет личного навыка',
    };
  }

  const { COMBAT } = config;
  const mods = modsOf(player, config);
  const { ability, fallback } = resolveAbility(player, auto ? 'атака' : command, config);
  const kind = ability.kind ?? 'damage';
  const descriptor = {
    kind,
    name: ability.name,
    damageType: null,
    element: player.element,
    amount: 0,
    crit: false,
    manaCost: manaCostOf(player, ability, config),
    fallback,
    missed: false,
  };

  if (mods.missChance > 0 && rand01(rng) < mods.missChance) {
    return { ...descriptor, kind: 'none', missed: true };
  }

  const power = auto ? COMBAT.AUTO_ACTION_POWER : 1;

  if (kind === 'heal' || kind === 'healAll') {
    return { ...descriptor, amount: ability.power * mods.healMult * power };
  }
  if (kind === 'taunt') {
    return { ...descriptor, amount: ability.damageTakenMult };
  }

  // Гарантированный крит навыка сильнее «Неудачника» (critChanceOverride = 0).
  const { amount, crit } = rollDamageAmount(player, ability.power * power, rng, {
    forceCrit: ability.guaranteedCrit === true,
    critMult: ability.critMult,
  }, config);

  return {
    ...descriptor,
    damageType: ability.damageType ?? playerDamageType(player, config),
    crit,
    amount,
  };
}

// Бросок урона игрока от базового значения: damageMult черт, крит, разброс ±15%.
//   forceCrit — гарантированный крит (сильнее critChanceOverride), noCrit — крита нет,
//   critMult — свой множитель крита (по умолчанию из конфига).
// Порядок бросков rng: крит (если не forceCrit/noCrit), затем разброс.
export function rollDamageAmount(player, baseDamage, rng, { forceCrit = false, noCrit = false, critMult } = {}, config = CONFIG) {
  const { COMBAT } = config;
  const mods = modsOf(player, config);
  const crit = forceCrit || (!noCrit && rand01(rng) < critChanceOf(player, config));
  const mult = crit ? critMult ?? COMBAT.CRIT_MULT : 1;
  const { min, max } = COMBAT.DMG_VARIANCE;
  const variance = min + rand01(rng) * (max - min);
  return { amount: Math.round(baseDamage * mods.damageMult * mult * variance), crit };
}

// Возвращает реально списанную ману.
export function spendMana(player, amount) {
  const spent = Math.min(player.mana, Math.max(0, amount));
  player.mana -= spent;
  return spent;
}

export function regenMana(player, config = CONFIG) {
  const regen = Math.round(player.maxMana * modsOf(player, config).manaRegenPct);
  player.mana = Math.min(player.maxMana, player.mana + regen);
}

// Урон с учётом damageTakenMult. Возвращает реально снятое HP.
export function takeDamage(player, amount, config = CONFIG) {
  if (player.status !== 'alive') return 0;
  const mods = modsOf(player, config);
  const taken = Math.min(player.hp, Math.round(amount * mods.damageTakenMult));
  player.hp -= taken;
  if (player.hp === 0) {
    player.status = 'downed';
    player.downedTurnsLeft = mods.reviveTurns;
  }
  return taken;
}

// Возвращает реально восстановленное HP (без перелечивания). Павших не лечит.
export function healPlayer(player, amount) {
  if (player.status !== 'alive' || amount <= 0) return 0;
  const before = player.hp;
  player.hp = Math.min(player.maxHp, player.hp + Math.round(amount));
  return player.hp - before;
}

export function recordAbsorbed(player, amount) {
  player.stats.absorbed += amount;
}

// Вызывается раз в начале каждого хода. Упал на ходу t → встаёт на t + reviveTurns.
// Возвращает true, если игрок встал.
export function tickDowned(player, config = CONFIG) {
  if (player.status !== 'downed') return false;
  player.downedTurnsLeft--;
  if (player.downedTurnsLeft > 0) return false;
  reviveNow(player, config.COMBAT.REVIVE_HP_PERCENT);
  return true;
}

// Поднять сразу (карта стримера, Воскрешение). Возвращает true, если игрок был downed.
export function reviveNow(player, percent) {
  if (player.status !== 'downed') return false;
  player.status = 'alive';
  player.hp = Math.max(1, Math.round(player.maxHp * percent));
  player.downedTurnsLeft = 0;
  return true;
}
