// Каталог званий. Условие: { stat, min } — поле записи игрока не меньше min.
// stat: battles | wins | mvps | lastHits | totalHealing | totalSupport.
// Игроку показывается полученное звание с наибольшим priority.

export const TITLE_CATALOG = [
  // Бои
  { id: 'battles_10', name: 'Новобранец', condition: { stat: 'battles', min: 10 }, priority: 10 },
  { id: 'battles_50', name: 'Ветеран', condition: { stat: 'battles', min: 50 }, priority: 30 },
  { id: 'battles_150', name: 'Старожил чата', condition: { stat: 'battles', min: 150 }, priority: 55 },

  // Победы
  { id: 'wins_1', name: 'Боец', condition: { stat: 'wins', min: 1 }, priority: 15 },
  { id: 'wins_5', name: 'Охотник на боссов', condition: { stat: 'wins', min: 5 }, priority: 35 },
  { id: 'wins_15', name: 'Гроза подземелий', condition: { stat: 'wins', min: 15 }, priority: 60 },
  { id: 'wins_40', name: 'Убийца драконов', condition: { stat: 'wins', min: 40 }, priority: 80 },
  { id: 'wins_100', name: 'Легенда чата', condition: { stat: 'wins', min: 100 }, priority: 100 },

  // MVP
  { id: 'mvp_1', name: 'Лучший в бою', condition: { stat: 'mvps', min: 1 }, priority: 20 },
  { id: 'mvp_5', name: 'Герой дня', condition: { stat: 'mvps', min: 5 }, priority: 50 },
  { id: 'mvp_15', name: 'Звезда арены', condition: { stat: 'mvps', min: 15 }, priority: 75 },

  // Добивания
  { id: 'lasthit_5', name: 'Добивающий', condition: { stat: 'lastHits', min: 5 }, priority: 40 },
  { id: 'lasthit_20', name: 'Палач боссов', condition: { stat: 'lastHits', min: 20 }, priority: 70 },

  // Лечение и поддержка (суммарно за все бои)
  { id: 'healing_5k', name: 'Полевой лекарь', condition: { stat: 'totalHealing', min: 5000 }, priority: 45 },
  { id: 'healing_25k', name: 'Святой целитель', condition: { stat: 'totalHealing', min: 25000 }, priority: 78 },
  { id: 'support_5k', name: 'Опора отряда', condition: { stat: 'totalSupport', min: 5000 }, priority: 45 },
  { id: 'support_25k', name: 'Душа команды', condition: { stat: 'totalSupport', min: 25000 }, priority: 78 },
];
