import { PERSONAL_SKILL_CATALOG } from './data/personal_skills.js';
import { TRAIT_CATALOG } from './data/traits.js';
import { STREAMER_CARD_CATALOG } from './data/streamer_cards.js';
import { TITLE_CATALOG } from '../points/data/titles.js';

export const CONFIG = {
  DAMAGE_TYPES: {
    physical: { name: 'физический', emoji: '⚔️' },
    magic: { name: 'магия', emoji: '🔮' },
    fire: { name: 'огонь', emoji: '🔥' },
    ice: { name: 'лёд', emoji: '❄️' },
    holy: { name: 'святой', emoji: '✨' },
  },
  BOSS_BASE_STATS: {
    // HP = (baseHp + perPlayerHp × игроков^playerExponent) × hpMult архетипа × 0.9..1.1.
    // Степень > 1: большой отряд бьёт стабильнее (случайности усредняются), ему нужен запас HP.
    baseHp: 300,
    perPlayerHp: 300,
    playerExponent: 1.08,
  },
  SKILL_WEIGHTS: {
    single: 40,
    aoe: 25,
    debuff: 20,
    buff: 15,
  },
  PHASE_THRESHOLDS: [0.66, 0.33],
  // Множитель урона босса по фазам 1, 2, 3 (см. getBossDamageMult).
  BOSS_PHASE_DAMAGE_MULT: [1.0, 1.1, 1.25],
  DAMAGE_VALUES: {
    single: { min: 0.30, max: 0.45 },
    aoe: { min: 0.15, max: 0.25 },
  },
  // ===== Часть 2: игроки и классы =====
  COMBAT: {
    CRIT_CHANCE: 0.10,
    CRIT_MULT: 1.5,
    DMG_VARIANCE: { min: 0.85, max: 1.15 },
    MANA_REGEN_PERCENT: 0.10,
    DOWNED_TURNS: 2,
    REVIVE_HP_PERCENT: 0.30,
    AUTO_ACTION_POWER: 0.75,
  },
  // Порядок ключей задаёт пороги при выборе по хешу.
  ELEMENT_CHANCES: {
    neutral: 0.40,
    fire: 0.20,
    ice: 0.20,
    holy: 0.20,
  },
  // Класс выдаётся случайно при !join: хеш (battleId, userId) с солью CLASS_SALT, веса ниже.
  // Порядок ключей задаёт пороги при выборе по хешу.
  CLASS_WEIGHTS: { warrior: 25, archer: 25, mage: 25, healer: 25 },
  CLASS_SALT: 'class',
  PLAYER_LIMIT: 1000, // максимум бойцов в одном бою (лишние получают молчаливый отказ)
  // Скиллы классов. power у heal/healAll — доля макс. HP цели; у taunt damageTakenMult — множитель
  // урона по воину. Урон Меткого выстрела = power × critMult = 45 × 2 = 90.
  PLAYER_CLASSES: {
    warrior: {
      name: 'Воин',
      plural: ['воин', 'воина', 'воинов'],
      emoji: '🛡️',
      hp: 120,
      mana: 30,
      nativeDamageType: 'physical',
      skills: {
        attack: { name: 'Удар', manaCost: 0, power: 40 },
        skill: { name: 'Провокация', manaCost: 15, kind: 'taunt', damageTakenMult: 0.5 },
      },
    },
    archer: {
      name: 'Лучник',
      plural: ['лучник', 'лучника', 'лучников'],
      emoji: '🏹',
      hp: 90,
      mana: 50,
      nativeDamageType: 'physical',
      skills: {
        attack: { name: 'Выстрел', manaCost: 0, power: 45 },
        skill: { name: 'Меткий выстрел', manaCost: 20, power: 45, guaranteedCrit: true, critMult: 2.0 },
      },
    },
    mage: {
      name: 'Маг',
      plural: ['маг', 'мага', 'магов'],
      emoji: '🔮',
      hp: 70,
      mana: 100,
      nativeDamageType: 'magic',
      skills: {
        attack: { name: 'Искра', manaCost: 0, power: 42 },
        skill: { name: 'Шар', manaCost: 40, power: 100 },
      },
    },
    healer: {
      name: 'Хиллер',
      plural: ['хиллер', 'хиллера', 'хиллеров'],
      emoji: '💚',
      hp: 85,
      mana: 90,
      nativeDamageType: 'holy',
      fixedElement: 'holy',
      skills: {
        attack: { name: 'Лечение', manaCost: 10, kind: 'heal', power: 0.35 },
        skill: { name: 'Молитва', manaCost: 35, kind: 'healAll', power: 0.15 },
        // Замена Лечения, когда на него не хватает маны.
        fallbackAttack: { name: 'Искра света', manaCost: 0, power: 15, damageType: 'holy' },
      },
    },
  },
  // ===== Часть 3: личные навыки и черты =====
  PERSONAL_SKILLS: {
    BASE_WEIGHT: 10,
    // Соли хеша (battleId:userId:соль): навык и редкость выбираются независимо.
    SALTS: { skill: 'skill', rarity: 'rarity' },
    // Порядок ключей задаёт пороги при выборе по хешу.
    RARITIES: {
      common: { name: 'обычный', chance: 0.70, mult: 1.0, durationBonus: 0, cooldown: 3 },
      rare: { name: 'редкий', chance: 0.25, mult: 1.25, durationBonus: 0, cooldown: 3 },
      epic: { name: 'эпический', chance: 0.05, mult: 1.6, durationBonus: 1, cooldown: 2 },
    },
    CATALOG: PERSONAL_SKILL_CATALOG,
  },
  TRAITS: TRAIT_CATALOG,
  // ===== Часть 5: движок боя =====
  BATTLE: {
    lobbySeconds: 75,
    lobbyProgressSeconds: 20,
    minPlayers: 1,
    turnWindowSeconds: 40, // время на ход: изучить персонажа, обсудить тактику, отправить команду
    firstTurnWindowSeconds: 60, // первый ход длиннее — осмотреться (!я, !гайд)
    maxTurns: 15,
    meCooldownSeconds: 20,
    pauseAfterBattleSeconds: 150,
    // Автобосс: после победы или поражения следующий бой начинается сам через pauseAfterBattleSeconds —
    // только пока идёт стрим. Включают и выключают в чате: !автобосс вкл / выкл (стример и модераторы).
    autoNextBoss: false,
    bossWaitNoticeCooldownSeconds: 10, // «⏳ Следующий босс через …» на ранний !босс — не чаще
    bossTopDamageChance: 0.25, // доля одиночных атак босса по самому опасному игроку
    maxNamesInSummary: 5,
    healVariance: 0.15, // разброс лечения ±15%
    // Ответ на !join: auto и batch — сводка вступивших раз в joinBatchSeconds;
    // always — короткий ответ каждому; off — молчать. Подробности игрок смотрит через !я.
    joinReplyMode: 'auto',
    joinBatchSeconds: 5,
    // «Такой команды нет. Может, ты про …?» — только на близкие опечатки наших команд.
    suggestCommands: true,
    suggestUserCooldownSeconds: 30, // одному зрителю — не чаще
    suggestGlobalCooldownSeconds: 5, // всему чату — не чаще
    resumeGraceSeconds: 15, // после перезапуска бота окну лобби/хода остаётся не меньше
  },
  // ===== Часть 7: слой Твича (не секреты; секреты — в .env) =====
  TWITCH: {
    vipCountsAsMod: true, // VIP-зрители получают права модератора в игре (например, !стоп)
    excludeUserIds: ['nightbot', 'streamelements', 'moobot', 'streamlabs', 'fossabot', 'wizebot'], // id или логин
    ignoreSharedChat: true, // сообщения из соседних каналов «общего чата» не участвуют
    dedupeSeconds: 60, // повторная доставка того же messageId игнорируется
    // Лимиты отправки с запасом от лимитов Твича (100 / 20 за 30 с; не-модератор — 1 в секунду).
    windowSeconds: 30,
    limits: {
      mod: { perWindow: 85, minIntervalMs: 350 }, // бот — модератор, VIP или стример
      normal: { perWindow: 17, minIntervalMs: 1200 },
    },
    lowMaxAgeSeconds: 15, // сообщения low старше — выбрасываются
    queueMax: 200,
    holdSeconds: 10, // без связи храним high и normal не дольше
    retryDelayMs: 2000, // одна повторная попытка отправки
    whisperFallbackToChat: false,
    maxResumeMinutes: 20, // бой из data/battle.json восстанавливается, если сохранён не раньше
    tickTimeoutSeconds: 5,
    autosaveSeconds: 10,
    shutdownFlushSeconds: 3,
    reconnectInitialSeconds: 1,
    reconnectMaxSeconds: 60,
    botStatusCooldownSeconds: 30,
    liveCheckSeconds: 60, // как часто спрашивать Твич, идёт ли стрим (для автобосса)
    // !поддержатьигру — ссылка на донат автору игры (не секрет; одинакова для всех, кто запускает бота).
    supportUrl: 'https://www.donationalerts.com/r/vovannoob',
    supportCooldownSeconds: 60, // общий кулдаун на весь чат
    // !гайд и !помощь — ссылка на правила для игроков.
    guideUrl: 'https://github.com/VasiliskBRO/twitch-boss-battle#для-игроков',
    guideCooldownSeconds: 60, // общий кулдаун на весь чат
    // Публичное приложение автора игры (Client Type: Public): стримеры входят по коду (setup.js)
    // без своей консоли разработчика. Client ID — не секрет. Своё приложение — TWITCH_CLIENT_ID в .env.
    publicClientId: null, // TODO: вписать Client ID после регистрации приложения
    authPort: 3000, // для старого способа auth.js: redirect URI http://localhost:3000/callback
    // Скоупы по документации Твича (EventSub channel.chat.message + Send Chat Message API).
    scopes: ['user:read:chat', 'user:write:chat', 'user:read:moderated_channels'],
    logFile: 'logs/bot.log',
    logMaxBytes: 2 * 1024 * 1024,
    logMaxFiles: 5,
    tokensFile: 'data/tokens.json',
    battleFile: 'data/battle.json',
    pointsFile: 'data/points.json',
  },
  // Эффекты навыков босса (поле effect в каталоге архетипов). Длительности — в ходах
  // «со следующего хода» (движок добавляет +1, потому что статус тикает в конце этого же хода).
  BOSS_SKILL_EFFECTS: {
    armor: { damageTakenMult: 0.7, turns: 2 },
    heal: { pctMaxHp: 0.08 },
    dmg_up: { turns: 2 }, // damageDealt = 1 + power навыка
    weaken: { pct: 0.25, turns: 2 },
    silence_class: { turns: 1 },
  },
  // Цели баланса для simulate.js: доля побед по сценариям.
  SIM_TARGETS: {
    engaged: { min: 0.60, max: 0.75 },
    lurkers: { min: 0.35, max: 0.55 },
    mixed: { min: 0.45, max: 0.65 },
  },
  // ===== Часть 6: очки, рейтинг и звания =====
  POINTS: {
    // вклад = damage × 1.0 + healing × 1.8 + absorbed × 0.5 + support × 1.0
    weights: { damage: 1.0, healing: 1.8, absorbed: 0.5, support: 1.0 },
    turnContributionCap: 0.10, // потолок вклада игрока за ход — доля макс. HP босса
    minActiveTurns: 2, // участник: столько явных команд за бой
    excludeUserIds: ['nightbot', 'streamelements', 'moobot', 'streamlabs'], // сравнение без учёта регистра
    participation: 50,
    poolPerParticipant: 100, // пул = 100 × N, делится пропорционально вкладу
    mvpBonus: 100,
    lastHitBonus: 50,
    defeatMult: 0.4, // defeat и wipe
    minAward: 1,
    // Фиксированная поддержка за реальное срабатывание — доля макс. HP босса.
    supportFixed: { antimagic: 0.03, cleanse: 0.02 },
    pointsCooldownSeconds: 30, // !очки на игрока
    topCooldownSeconds: 60, // !топ общий
    topSize: 5,
    storeDebounceMs: 2000,
    keepProcessedBattles: 1000, // сколько последних battleId помнить для идемпотентности
  },
  TITLES: TITLE_CATALOG,
  // ===== Часть 4: карты стримера =====
  // Имена настроек как в ТЗ части 4.
  STREAMER: {
    handSize: 3,
    minTurnsBetween: 2, // сыграл на ходу t → следующий раз с хода t + 2
    momentSeconds: 15,
    handVisibility: 'public', // public | private
    allowMods: false,
    replyToUnauthorized: false,
    handCommandCooldownSeconds: 10, // !рука не чаще раза в 10 с
    CATALOG: STREAMER_CARD_CATALOG,
  },
  ARCHETYPES: {
    beast: {
      name: 'Зверь',
      emoji: '🐾',
      hpMult: 1.0,
      dmgMult: 1.0,
      nouns: {
        m: ['Волк', 'Медведь', 'Тигр', 'Лев'],
        f: ['Рысь', 'Пантера', 'Лисица', 'Кобра'],
        n: ['Чудище', 'Сотворение'],
      },
      adjectives: {
        m: ['Яростный', 'Дикий', 'Голодный', 'Огромный'],
        f: ['Яростная', 'Дикая', 'Голодная', 'Огромная'],
        n: ['Яростное', 'Дикое', 'Голодное', 'Огромное'],
      },
      epithets: ['Лесов', 'Пустынь', 'Джунглей', 'Гор'],
      potentialWeaknesses: ['ice', 'holy'],
      potentialResistances: ['physical'],
      skillPool: [
        { id: 'beast_bite', name: 'Рваный укус', kind: 'single', power: 1.0, cooldown: 2, unlockPhase: 1, announceText: 'Босс впивается зубами в цель!' },
        { id: 'beast_roar', name: 'Устрашающий рев', kind: 'aoe', power: 1.0, cooldown: 3, unlockPhase: 1, announceText: 'Босс издаёт оглушительный рёв по всем!' },
        { id: 'beast_claw', name: 'Раздирающий удар', kind: 'single', power: 1.1, cooldown: 2, unlockPhase: 1, announceText: 'Босс наносит мощный удар когтями!' },
        { id: 'beast_frenzy', name: 'Кровавое безумие', kind: 'buff', effect: 'dmg_up', power: 0.2, cooldown: 5, unlockPhase: 2, announceText: 'Босс впадает в ярость!' },
        { id: 'beast_pounce', name: 'Смертельный прыжок', kind: 'single', power: 1.3, cooldown: 4, unlockPhase: 2, announceText: 'Босс обрушивается на цель сверху!' },
        { id: 'beast_stampede', name: 'Топотуха', kind: 'aoe', power: 0.9, cooldown: 3, unlockPhase: 1, announceText: 'Босс врывается в толпу!' },
      ],
    },
    undead: {
      name: 'Нежить',
      emoji: '💀',
      hpMult: 0.95,
      dmgMult: 0.9,
      nouns: {
        m: ['Лич', 'Скелет', 'Рыцарь', 'Зомби'],
        f: ['Банши', 'Фурия', 'Муммия'],
        n: ['Привидение', 'Создание'],
      },
      adjectives: {
        m: ['Гнилой', 'Мертвый', 'Бледный', 'Проклятый'],
        f: ['Гнилая', 'Мертвая', 'Бледная', 'Проклятая'],
        n: ['Гнилое', 'Мертвое', 'Бледное', 'Проклятое'],
      },
      epithets: ['Кладбища', 'Склепа', 'Забытых земель', 'Могил'],
      potentialWeaknesses: ['holy', 'fire'],
      potentialResistances: ['physical', 'ice'],
      skillPool: [
        { id: 'undead_drain', name: 'Похищение жизни', kind: 'single', power: 1.0, cooldown: 3, unlockPhase: 1, announceText: 'Босс вытягивает жизненную силу!' },
        { id: 'undead_miasma', name: 'Гнилое облако', kind: 'aoe', power: 1.0, cooldown: 3, unlockPhase: 1, announceText: 'Босс выпускает ядовитый туман!' },
        { id: 'undead_curse', name: 'Проклятие смерти', kind: 'debuff', effect: 'weaken', power: 1.0, cooldown: 4, unlockPhase: 1, announceText: 'Босс накладывает проклятие!' },
        { id: 'undead_rise', name: 'Поднятие павших', kind: 'buff', effect: 'heal', power: 0.1, cooldown: 5, unlockPhase: 2, announceText: 'Босс черпает силы из смерти!' },
        { id: 'undead_chill', name: 'Ледяной шепот', kind: 'single', power: 1.1, cooldown: 2, unlockPhase: 1, announceText: 'Босс шепчет слова смерти!' },
        { id: 'undead_grave', name: 'Хватка могилы', kind: 'single', power: 1.2, cooldown: 3, unlockPhase: 2, announceText: 'Костлявые руки тянутся из земли!' },
      ],
    },
    demon: {
      name: 'Демон',
      emoji: '😈',
      hpMult: 1.0,
      dmgMult: 1.2,
      nouns: {
        m: ['Инферно', 'Белзевул', 'Князь', 'Демон'],
        f: ['Суккуб', 'Лилит', 'Ведьма'],
        n: ['Отродье', 'Существо'],
      },
      adjectives: {
        m: ['Пламенный', 'Коварный', 'Зловещий', 'Адский'],
        f: ['Пламенная', 'Коварная', 'Зловещая', 'Адская'],
        n: ['Пламенное', 'Коварное', 'Зловещее', 'Адское'],
      },
      epithets: ['Бездны', 'Преисподней', 'Седьмого круга', 'Пламени'],
      potentialWeaknesses: ['holy', 'ice'],
      potentialResistances: ['fire'],
      skillPool: [
        { id: 'demon_blast', name: 'Адский взрыв', kind: 'aoe', power: 1.0, cooldown: 3, unlockPhase: 1, announceText: 'Босс вызывает вспышку адского огня!' },
        { id: 'demon_strike', name: 'Удар Бездны', kind: 'single', power: 1.2, cooldown: 2, unlockPhase: 1, announceText: 'Босс наносит сокрушительный удар!' },
        { id: 'demon_fear', name: 'Взор ужаса', kind: 'debuff', effect: 'silence_class', power: 1.0, cooldown: 4, unlockPhase: 1, announceText: 'Босс заставляет игроков дрожать от страха!' },
        { id: 'demon_shield', name: 'Демонический щит', kind: 'buff', effect: 'armor', power: 1.0, cooldown: 5, unlockPhase: 2, announceText: 'Босс окутывает себя темной энергией!' },
        { id: 'demon_burn', name: 'Испепеление', kind: 'single', power: 1.4, cooldown: 3, unlockPhase: 2, announceText: 'Босс сжигает цель заживо!' },
        { id: 'demon_chaos', name: 'Хаотический разряд', kind: 'aoe', power: 0.8, cooldown: 2, unlockPhase: 1, announceText: 'Босс выпускает разряды хаоса!' },
      ],
    },
    golem: {
      name: 'Голем',
      emoji: '🗿',
      hpMult: 1.0,
      dmgMult: 0.8,
      nouns: {
        m: ['Страж', 'Колосс', 'Титана', 'Голем'],
        f: ['Скала', 'Стена', 'Башня'],
        n: ['Истукан', 'Создание'],
      },
      adjectives: {
        m: ['Каменный', 'Железный', 'Незыблемый', 'Тяжелый'],
        f: ['Каменная', 'Железная', 'Незыблемая', 'Тяжелая'],
        n: ['Каменное', 'Железное', 'Незыблемое', 'Тяжелое'],
      },
      epithets: ['Древних руин', 'Забытого города', 'Подземелий', 'Гор'],
      potentialWeaknesses: ['magic', 'ice'],
      potentialResistances: ['physical', 'fire'],
      skillPool: [
        { id: 'golem_slam', name: 'Дробящий удар', kind: 'single', power: 1.1, cooldown: 3, unlockPhase: 1, announceText: 'Босс с силой бьёт кулаком по земле!' },
        { id: 'golem_quake', name: 'Землетрясение', kind: 'aoe', power: 1.0, cooldown: 4, unlockPhase: 1, announceText: 'Босс вызывает мощный толчок почвы!' },
        { id: 'golem_harden', name: 'Укрепление', kind: 'buff', effect: 'armor', power: 1.0, cooldown: 5, unlockPhase: 1, announceText: 'Босс уплотняет свою структуру!' },
        { id: 'golem_throw', name: 'Бросок глыбы', kind: 'single', power: 1.2, cooldown: 3, unlockPhase: 2, announceText: 'Босс швыряет огромный камень в цель!' },
        { id: 'golem_stomp', name: 'Сокрушающий топот', kind: 'aoe', power: 0.9, cooldown: 3, unlockPhase: 2, announceText: 'Босс раздавливает всё вокруг!' },
        { id: 'golem_slow', name: 'Каменные оковы', kind: 'debuff', effect: 'weaken', power: 1.0, cooldown: 4, unlockPhase: 1, announceText: 'Босс замедляет движения игроков!' },
      ],
    },
    elemental: {
      name: 'Элементаль',
      emoji: '🌀',
      hpMult: 1.0,
      dmgMult: 1.1,
      nouns: {
        m: ['Дух', 'Вихрь', 'Поток', 'Элементаль'],
        f: ['Стихия', 'Искра', 'Волна'],
        n: ['Облако', 'Явление'],
      },
      adjectives: {
        m: ['Эфирный', 'Нестабильный', 'Яркий', 'Бушующий'],
        f: ['Эфирная', 'Нестабильная', 'Яркая', 'Бушующая'],
        n: ['Эфирное', 'Нестабильное', 'Яркое', 'Бушующее'],
      },
      epithets: ['Первозданного хаоса', 'Эфирных планов', 'Стихий', 'Небес'],
      potentialWeaknesses: ['physical', 'holy'],
      potentialResistances: ['magic'],
      skillPool: [
        { id: 'elem_surge', name: 'Стихийный всплеск', kind: 'aoe', power: 1.0, cooldown: 3, unlockPhase: 1, announceText: 'Босс вызывает неконтролируемый выброс энергии!' },
        { id: 'elem_bolt', name: 'Разряд энергии', kind: 'single', power: 1.1, cooldown: 2, unlockPhase: 1, announceText: 'Босс бьёт концентрированным лучом!' },
        { id: 'elem_shift', name: 'Смена формы', kind: 'buff', effect: 'armor', power: 1.0, cooldown: 5, unlockPhase: 1, announceText: 'Босс меняет свою плотность!' },
        { id: 'elem_storm', name: 'Великий шторм', kind: 'aoe', power: 1.2, cooldown: 4, unlockPhase: 2, announceText: 'Босс создает вокруг себя настоящий шторм!' },
        { id: 'elem_drain', name: 'Поглощение магии', kind: 'debuff', effect: 'silence_class', power: 1.0, cooldown: 4, unlockPhase: 2, announceText: 'Босс высасывает энергию из игроков!' },
        { id: 'elem_pulse', name: 'Энергетический импульс', kind: 'aoe', power: 0.8, cooldown: 2, unlockPhase: 1, announceText: 'Босс испускает волну энергии!' },
      ],
    },
    dragon: {
      name: 'Дракон',
      emoji: '🐉',
      hpMult: 0.95,
      dmgMult: 1.1,
      nouns: {
        m: ['Дракон', 'Змей', 'Тиран', 'Владыка'],
        f: ['Драконица', 'Матриарх'],
        n: ['Существо', 'Создание'],
      },
      adjectives: {
        m: ['Древний', 'Чешуйчатый', 'Могучий', 'Ржавый'],
        f: ['Древняя', 'Чешуйчатая', 'Могучая', 'Ржавая'],
        n: ['Древнее', 'Чешуйчатое', 'Могучее', 'Ржавое'],
      },
      epithets: ['Бездны', 'Вершин', 'Огненных гор', 'Забытых эпох'],
      potentialWeaknesses: ['ice', 'holy'],
      potentialResistances: ['fire', 'physical'],
      skillPool: [
        { id: 'drag_breath', name: 'Огненное дыхание', kind: 'aoe', power: 1.0, cooldown: 3, unlockPhase: 1, announceText: 'Босс извергает струю пламени по всем!' },
        { id: 'drag_bite', name: 'Драконий укус', kind: 'single', power: 1.2, cooldown: 2, unlockPhase: 1, announceText: 'Босс впивается огромными клыками в цель!' },
        { id: 'drag_tail', name: 'Удар хвостом', kind: 'aoe', power: 0.9, cooldown: 3, unlockPhase: 1, announceText: 'Босс сносит всех мощным ударом хвоста!' },
        { id: 'drag_roar', name: 'Глас Тирана', kind: 'debuff', effect: 'weaken', power: 1.0, cooldown: 4, unlockPhase: 2, announceText: 'Босс издает рев, подавляющий волю!' },
        { id: 'drag_scale', name: 'Алмазная чешуя', kind: 'buff', effect: 'armor', power: 1.0, cooldown: 5, unlockPhase: 2, announceText: 'Босс напрягает свою несокрушимую чешую!' },
        { id: 'drag_claw', name: 'Раздирающий коготь', kind: 'single', power: 1.3, cooldown: 3, unlockPhase: 1, announceText: 'Босс наносит глубокую рану!' },
      ],
    },
  },
};
