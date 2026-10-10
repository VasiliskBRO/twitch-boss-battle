import { CONFIG } from './config.js';

// Общая таблица типов эффектов. Дескриптор навыка — массив эффектов { type, ...поля }.
// Применяет эффекты часть 5; здесь только схема и проверка.
// Типы полей: number (> 0), int (целое >= 1), pct (доля в (0, 1]), boolean, false (строго false), string,
// damageType (ключ CONFIG.DAMAGE_TYPES), scope ('nextBossAttack'),
// суффикс '?' — поле обязательно, но может быть null.
export const EFFECT_TYPES = {
  damage: {
    mult: 'number',
    hits: 'int',
    damageType: 'damageType',
    ignoreResist: 'boolean',
    scaleByMissingHp: 'scaleByMissingHp?',
    phaseBonus: 'phaseBonus?',
  },
  dot: { turns: 'int', perTurnMult: 'number' },
  reflect: { pct: 'pct' },
  bossVulnerable: { pct: 'pct', turns: 'int' },
  removeBossStatus: { id: 'string' },
  cancelBossBuff: {},
  teamDamageReduction: { pct: 'pct', scope: 'scope' },
  teamAbsorb: { pctMaxHp: 'pct', scope: 'scope' },
  reviveAll: { pct: 'pct' },
  cleanse: { immunityTurns: 'int' },
  teamDamageBoost: { pct: 'pct', turns: 'int' },
  // damageType добавлен к полям из ТЗ: части 5 нужен тип урона Метеора.
  delayedDamage: { mult: 'number', delayTurns: 'int', damageType: 'damageType' },

  // Часть 4: карты стримера.
  blockNextBossAttack: {},
  cancelBossAction: {},
  healAll: { pctMaxHp: 'pct' },
  restoreManaAll: { pctMax: 'pct' },
  trueDamageBoss: { pctMaxHp: 'pct', canKill: 'false' },
  bossDamageBoost: { pct: 'number', turns: 'int' },
  bossDamageTakenReduction: { pct: 'pct', turns: 'int' },
  silenceRandomClass: { turns: 'int' },
  healBoss: { pctMaxHp: 'pct' },
  swapBossAffinities: {},
  teamDamagePenalty: { pct: 'pct', turns: 'int' },
};

const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

const FIELD_CHECKS = {
  number: isPositive,
  int: (v) => Number.isInteger(v) && v >= 1,
  pct: (v) => isPositive(v) && v <= 1,
  boolean: (v) => typeof v === 'boolean',
  false: (v) => v === false,
  string: (v) => typeof v === 'string' && v.length > 0,
  damageType: (v, config) => typeof v === 'string' && v in config.DAMAGE_TYPES,
  scope: (v) => v === 'nextBossAttack',
  scaleByMissingHp: (v) => v !== null && typeof v === 'object' && isPositive(v.k) && isPositive(v.cap) && v.cap >= 1,
  phaseBonus: (v) => v !== null && typeof v === 'object' && Number.isInteger(v.minPhase) && isPositive(v.mult),
};

// Возвращает список ошибок; пустой список — эффект валиден.
export function validateEffect(effect, config = CONFIG) {
  if (!effect || typeof effect !== 'object') return ['effect is not an object'];
  const schema = EFFECT_TYPES[effect.type];
  if (!schema) return [`unknown effect type: ${effect.type}`];

  const errors = [];
  for (const key of Object.keys(effect)) {
    if (key !== 'type' && !(key in schema)) errors.push(`${effect.type}: unknown field ${key}`);
  }
  for (const [field, spec] of Object.entries(schema)) {
    const nullable = spec.endsWith('?');
    const kind = nullable ? spec.slice(0, -1) : spec;
    if (!(field in effect)) {
      errors.push(`${effect.type}: missing field ${field}`);
      continue;
    }
    const value = effect[field];
    if (nullable && value === null) continue;
    if (!FIELD_CHECKS[kind](value, config)) errors.push(`${effect.type}: bad ${field} = ${JSON.stringify(value)}`);
  }
  return errors;
}
