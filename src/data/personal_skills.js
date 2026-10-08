// Каталог личных навыков (!особый). Числа — стартовые заглушки, баланс настраивается здесь.
//
// effects    — шаблон дескриптора из EFFECT_TYPES (src/effects.js). damageType у урона
//              подставляется при сборке по стихии игрока, поэтому в шаблоне null.
// scale      — пути полей effects, которые умножаются на множитель редкости.
// durations  — пути длительностей, к которым эпическая редкость добавляет ходы.
// weightRules — множители к базовому весу (см. getSkillWeights):
//   bossHasKind { kind, mult, elseMult }       — у босса есть навык этого kind
//   bossKindCountAtLeast { kind, count, mult } — у босса не меньше count навыков kind
//   bossHasEffect { effect, mult }             — у босса есть навык с этим effect
//   archetypeIn { archetypes, mult }           — архетип босса из списка
//   resistMatchesPlayerType { mult }           — тип урона игрока = сопротивление босса
// compensator — навык возвращает урон к ×1 против сопротивления (у хиллера таких нет).
// text       — описание для чата; {путь|формат}: pct, x, num, turns, hits.

const damage = (fields) => ({
  type: 'damage',
  mult: 1,
  hits: 1,
  damageType: null,
  ignoreResist: false,
  scaleByMissingHp: null,
  phaseBonus: null,
  ...fields,
});

const COMPENSATOR_RULE = { type: 'resistMatchesPlayerType', mult: 3 };

export const PERSONAL_SKILL_CATALOG = [
  // ВОИН
  {
    id: 'berserk',
    classId: 'warrior',
    name: 'Берсерк',
    effects: [damage({ scaleByMissingHp: { k: 4, cap: 5 } })],
    scale: ['0.scaleByMissingHp.k'],
    durations: [],
    weightRules: [],
    text: 'урон ×(1 + {0.scaleByMissingHp.k|num}·доля потерянного HP), до {0.scaleByMissingHp.cap|x}',
  },
  {
    id: 'counter_strike',
    classId: 'warrior',
    name: 'Контрудар',
    effects: [{ type: 'reflect', pct: 0.5 }],
    scale: ['0.pct'],
    durations: [],
    weightRules: [{ type: 'bossKindCountAtLeast', kind: 'single', count: 2, mult: 2 }],
    text: 'отражает {0.pct|pct} полученного урона',
  },
  {
    id: 'armor_break',
    classId: 'warrior',
    name: 'Раскол брони',
    effects: [{ type: 'bossVulnerable', pct: 0.25, turns: 2 }],
    scale: ['0.pct'],
    durations: ['0.turns'],
    weightRules: [{ type: 'bossHasEffect', effect: 'armor', mult: 2 }],
    text: 'босс получает +{0.pct|pct} урона на {0.turns|turns}',
  },
  {
    id: 'piercing_strike',
    classId: 'warrior',
    name: 'Пробивающий удар',
    compensator: true,
    effects: [damage({ mult: 1.2, ignoreResist: true })],
    scale: ['0.mult'],
    durations: [],
    weightRules: [COMPENSATOR_RULE],
    text: 'урон {0.mult|x}, игнорирует сопротивление',
  },

  // ЛУЧНИК
  {
    id: 'poison_arrow',
    classId: 'archer',
    name: 'Ядовитая стрела',
    effects: [damage({ mult: 0.8 }), { type: 'dot', turns: 3, perTurnMult: 0.3 }],
    scale: ['0.mult', '1.perTurnMult'],
    durations: ['1.turns'],
    weightRules: [{ type: 'archetypeIn', archetypes: ['undead', 'golem', 'elemental'], mult: 0.3 }],
    text: 'урон {0.mult|x} и яд на {1.turns|turns} по {1.perTurnMult|pct} базового',
  },
  {
    id: 'weak_spot',
    classId: 'archer',
    name: 'Выстрел в слабое место',
    effects: [damage({ mult: 1.5, phaseBonus: { minPhase: 2, mult: 2.25 } })],
    scale: ['0.mult', '0.phaseBonus.mult'],
    durations: [],
    weightRules: [],
    text: 'урон {0.mult|x}, с 2-й фазы {0.phaseBonus.mult|x}',
  },
  {
    id: 'arrow_rain',
    classId: 'archer',
    name: 'Град стрел',
    effects: [damage({ mult: 0.6, hits: 3 })],
    scale: ['0.mult'],
    durations: [],
    weightRules: [],
    text: '{0.hits|hits} по {0.mult|x}, крит у каждого свой',
  },
  {
    id: 'armor_piercing_arrow',
    classId: 'archer',
    name: 'Бронебойная стрела',
    compensator: true,
    effects: [damage({ mult: 1.2, ignoreResist: true })],
    scale: ['0.mult'],
    durations: [],
    weightRules: [COMPENSATOR_RULE],
    text: 'урон {0.mult|x}, игнорирует сопротивление',
  },

  // МАГ
  {
    id: 'antimagic',
    classId: 'mage',
    name: 'Антимагия',
    effects: [{ type: 'removeBossStatus', id: 'armor' }, { type: 'cancelBossBuff' }],
    scale: [],
    durations: [],
    weightRules: [{ type: 'bossHasKind', kind: 'buff', mult: 3, elseMult: 0.3 }],
    text: 'снимает броню босса и отменяет его бафф',
  },
  {
    id: 'magic_barrier',
    classId: 'mage',
    name: 'Магический барьер',
    effects: [{ type: 'teamDamageReduction', pct: 0.3, scope: 'nextBossAttack' }],
    scale: ['0.pct'],
    durations: [],
    weightRules: [{ type: 'bossHasKind', kind: 'aoe', mult: 2 }],
    text: 'отряд получает −{0.pct|pct} урона от следующей атаки босса',
  },
  {
    id: 'meteor',
    classId: 'mage',
    name: 'Метеор',
    // delayTurns не длительность: эпик не откладывает падение (решение по ТЗ).
    effects: [{ type: 'delayedDamage', mult: 3.5, delayTurns: 1, damageType: null }],
    scale: ['0.mult'],
    durations: [],
    weightRules: [],
    text: 'урон {0.mult|x} в конце следующего хода, отменить нельзя',
  },
  {
    id: 'spell_break',
    classId: 'mage',
    name: 'Разрыв чар',
    compensator: true,
    effects: [damage({ mult: 1.2, ignoreResist: true })],
    scale: ['0.mult'],
    durations: [],
    weightRules: [COMPENSATOR_RULE],
    text: 'урон {0.mult|x}, игнорирует сопротивление',
  },

  // ХИЛЛЕР (компенсатора нет)
  {
    id: 'resurrection',
    classId: 'healer',
    name: 'Воскрешение',
    effects: [{ type: 'reviveAll', pct: 0.5 }],
    scale: ['0.pct'],
    durations: [],
    weightRules: [{ type: 'bossHasKind', kind: 'aoe', mult: 3 }],
    text: 'поднимает всех павших с {0.pct|pct} HP',
  },
  {
    id: 'purification',
    classId: 'healer',
    name: 'Очищение',
    effects: [{ type: 'cleanse', immunityTurns: 1 }],
    scale: [],
    durations: ['0.immunityTurns'],
    weightRules: [{ type: 'bossHasKind', kind: 'debuff', mult: 3, elseMult: 0.3 }],
    text: 'снимает дебаффы босса, иммунитет на {0.immunityTurns|turns}',
  },
  {
    id: 'blessing',
    classId: 'healer',
    name: 'Благословение',
    effects: [{ type: 'teamDamageBoost', pct: 0.25, turns: 2 }],
    scale: ['0.pct'],
    durations: ['0.turns'],
    weightRules: [],
    text: '+{0.pct|pct} урона всему отряду на {0.turns|turns}',
  },
  {
    id: 'light_shield',
    classId: 'healer',
    name: 'Щит света',
    effects: [{ type: 'teamAbsorb', pctMaxHp: 0.1, scope: 'nextBossAttack' }],
    scale: ['0.pctMaxHp'],
    durations: [],
    weightRules: [{ type: 'bossHasKind', kind: 'aoe', mult: 2 }],
    text: 'каждый поглощает до {0.pctMaxHp|pct} макс. HP урона следующей атаки',
  },
];
