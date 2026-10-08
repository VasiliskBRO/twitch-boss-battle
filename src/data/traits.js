// Каталог черт. polarity: gift (дар) | curse (проклятие).
// group: две черты одной группы не выпадают одному игроку.
// classes: 'all' или список классов, которым черта допустима.
// mods: значения модификаторов (как сочетаются — см. MOD_RULES в src/traits.js).

const CASTERS = ['archer', 'mage', 'healer']; // у кого мана имеет смысл
const CRITTERS = ['warrior', 'archer', 'mage']; // у кого есть крит

export const TRAIT_CATALOG = [
  // ДАРЫ
  { id: 'sturdy', name: 'Крепкая шкура', polarity: 'gift', group: 'hp', classes: 'all', mods: { maxHpMult: 1.2 } },
  { id: 'mana_pool', name: 'Запас маны', polarity: 'gift', group: 'manaPool', classes: CASTERS, mods: { maxManaMult: 1.3 } },
  { id: 'keen_eye', name: 'Меткий глаз', polarity: 'gift', group: 'crit', classes: CRITTERS, mods: { critChanceAdd: 0.10 } },
  { id: 'quick_mana', name: 'Быстрое восстановление', polarity: 'gift', group: 'manaRegen', classes: CASTERS, mods: { manaRegenPct: 0.15 } },
  { id: 'tenacious', name: 'Живучий', polarity: 'gift', group: 'revive', classes: 'all', mods: { reviveTurns: 1 } },
  { id: 'strong_hand', name: 'Сильная рука', polarity: 'gift', group: 'damage', classes: 'all', mods: { damageMult: 1.15, healMult: 1.15 } },
  { id: 'thrifty', name: 'Экономный', polarity: 'gift', group: 'manaCost', classes: CASTERS, mods: { manaCostMult: 0.75 } },
  { id: 'thick_skin', name: 'Толстокожий', polarity: 'gift', group: 'damageTaken', classes: 'all', mods: { damageTakenMult: 0.85 } },

  // ПРОКЛЯТИЯ
  { id: 'frail', name: 'Хрупкий', polarity: 'curse', group: 'hp', classes: 'all', mods: { maxHpMult: 0.8 } },
  { id: 'weak_hand', name: 'Слабая рука', polarity: 'curse', group: 'damage', classes: 'all', mods: { damageMult: 0.85, healMult: 0.85 } },
  { id: 'unlucky', name: 'Неудачник', polarity: 'curse', group: 'crit', classes: CRITTERS, mods: { critChanceOverride: 0 } },
  { id: 'drained', name: 'Истощение', polarity: 'curse', group: 'manaRegen', classes: CASTERS, mods: { manaRegenPct: 0.05 } },
  { id: 'wasteful', name: 'Расточитель', polarity: 'curse', group: 'manaCost', classes: CASTERS, mods: { manaCostMult: 1.3 } },
  { id: 'shaky', name: 'Дрожащие руки', polarity: 'curse', group: 'miss', classes: 'all', mods: { missChance: 0.15 } },
  { id: 'magnet', name: 'Магнит для ударов', polarity: 'curse', group: 'target', classes: 'all', mods: { bossTargetWeight: 2 } },
  { id: 'sluggish', name: 'Тугодум', polarity: 'curse', group: 'cooldown', classes: 'all', mods: { personalCooldownBonus: 2 } },
];
