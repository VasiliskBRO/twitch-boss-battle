// Каталог карт стримера. Числа — стартовые заглушки для баланса.
// Все эффекты процентные и направлены только на босса, весь отряд или целый класс,
// поэтому работают одинаково при 10 и при 1000 участников.
//
// kind: help (помощь чату) | hinder (помеха чату).
// effects: эффекты из EFFECT_TYPES (src/effects.js), применяет их часть 5.
// announceText: текст для чата; short — короткое описание для !рука;
// {путь|формат} подставляет число из effects
// (форматы: pct, x, num, turns, forTurns — см. fillTemplate в src/text.js).

export const STREAMER_CARD_CATALOG = [
  // ПОМОЩЬ
  {
    id: 'shield', name: 'Щит', emoji: '🛡️', kind: 'help',
    effects: [{ type: 'blockNextBossAttack' }],
    announceText: 'Следующая атака босса полностью блокируется.',
    short: 'блок следующей атаки',
  },
  {
    id: 'blessing', name: 'Благословение', emoji: '🙏', kind: 'help',
    effects: [{ type: 'healAll', pctMaxHp: 0.25 }],
    announceText: 'Все живые игроки лечатся на {0.pctMaxHp|pct} макс. HP.',
    short: 'лечит всех на {0.pctMaxHp|pct}',
  },
  {
    id: 'war_cry', name: 'Боевой клич', emoji: '📣', kind: 'help',
    effects: [{ type: 'teamDamageBoost', pct: 0.25, turns: 2 }],
    announceText: 'Урон всех игроков +{0.pct|pct} {0.turns|forTurns}.',
    short: 'урон отряда +{0.pct|pct} {0.turns|forTurns}',
  },
  {
    id: 'resurrection', name: 'Воскрешение', emoji: '✨', kind: 'help',
    effects: [{ type: 'reviveAll', pct: 0.5 }],
    announceText: 'Все павшие возвращаются в бой с {0.pct|pct} HP.',
    short: 'павшие встают с {0.pct|pct} HP',
  },
  {
    id: 'mana_gift', name: 'Дар маны', emoji: '🔮', kind: 'help',
    effects: [{ type: 'restoreManaAll', pctMax: 0.5 }],
    announceText: 'Все игроки восстанавливают {0.pctMax|pct} макс. маны.',
    short: 'всем +{0.pctMax|pct} маны',
  },
  {
    id: 'streamer_strike', name: 'Удар стримера', emoji: '🎯', kind: 'help',
    effects: [{ type: 'trueDamageBoss', pctMaxHp: 0.05, canKill: false }],
    announceText: 'Босс теряет {0.pctMaxHp|pct} макс. HP чистым уроном.',
    short: 'босс −{0.pctMaxHp|pct} HP',
  },

  // ПОМЕХА
  {
    id: 'fury', name: 'Ярость', emoji: '😡', kind: 'hinder',
    effects: [{ type: 'bossDamageBoost', pct: 0.5, turns: 1 }],
    announceText: 'Урон босса +{0.pct|pct} {0.turns|forTurns}.',
    short: 'урон босса +{0.pct|pct} {0.turns|forTurns}',
  },
  {
    id: 'minions', name: 'Прислужники', emoji: '👹', kind: 'hinder',
    effects: [{ type: 'bossDamageTakenReduction', pct: 0.4, turns: 2 }],
    announceText: 'Прислужники принимают удары: урон по боссу −{0.pct|pct} {0.turns|forTurns}.',
    short: 'урон по боссу −{0.pct|pct} {0.turns|forTurns}',
  },
  {
    id: 'curse', name: 'Проклятие', emoji: '🤐', kind: 'hinder',
    effects: [{ type: 'silenceRandomClass', turns: 1 }],
    announceText: 'Один случайный класс не может использовать !навык и !особый {0.turns|forTurns}.',
    short: 'случайный класс без навыков {0.turns|forTurns}',
  },
  {
    id: 'regen', name: 'Регенерация', emoji: '🩸', kind: 'hinder',
    effects: [{ type: 'healBoss', pctMaxHp: 0.08 }],
    announceText: 'Босс восстанавливает {0.pctMaxHp|pct} макс. HP.',
    short: 'босс +{0.pctMaxHp|pct} HP',
  },
  {
    id: 'element_swap', name: 'Смена стихии', emoji: '🔄', kind: 'hinder',
    effects: [{ type: 'swapBossAffinities' }],
    announceText: 'Слабость и сопротивление босса меняются местами!',
    short: 'слабость ⇄ сопротивление',
  },
  {
    id: 'fog', name: 'Туман', emoji: '🌫️', kind: 'hinder',
    effects: [{ type: 'teamDamagePenalty', pct: 0.25, turns: 1 }],
    announceText: 'Весь урон игроков −{0.pct|pct} {0.turns|forTurns}.',
    short: 'урон отряда −{0.pct|pct} {0.turns|forTurns}',
  },
];
