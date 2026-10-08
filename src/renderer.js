import { CONFIG } from './config.js';
import { plural, clip, TURN_FORMS } from './text.js';
import { getSkillDef } from './personal_skills.js';
import { getTraitDef, describeTrait } from './traits.js';

export function renderHpBar(boss, width = 10) {
  const percent = boss.hp / boss.maxHp;
  const filledLength = Math.round(width * percent);
  const emptyLength = width - filledLength;
  const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
  return `[${bar}] ${boss.hp}/${boss.maxHp}`;
}

export function renderSpawn(boss) {
  const arch = CONFIG.ARCHETYPES[boss.archetype];
  const typeInfo = CONFIG.DAMAGE_TYPES;

  const msg1 = `${arch.emoji} ПОЯВИЛСЯ: ${boss.name} | ${arch.name}`;

  const hpText = boss.hpFinal
    ? `❤️ HP: ${boss.hp}/${boss.maxHp}`
    : '❤️ HP: считается после сбора отряда';

  const msg2 = `${hpText} | ⚔️ Слабость: ${typeInfo[boss.weakness].emoji} ${typeInfo[boss.weakness].name} | 🛡️ Сопротивление: ${typeInfo[boss.resistance].emoji} ${typeInfo[boss.resistance].name}`;

  const skillsNames = boss.skills.map(s => s.name).join(', ');
  const msg3 = `💥 Навыки: ${skillsNames}`;

  return [msg1, msg2, msg3];
}

export function renderTelegraph(boss) {
  if (!boss.pendingAttack) return 'Босс медлит...';
  const attack = boss.pendingAttack;
  return `⚠️ Босс готовит ${attack.name} ${attack.kind === 'aoe' ? 'по всем!' : 'в цель!'}`;
}

// Персонаж одной строкой (≤ 500):
// «@ник, ты 🛡️ Воин 🔥 | ❤️ 120/120 | 🔷 30/30 | ✨ Особый: Контрудар (редкий) | 🎁 Дар: Крепкая шкура (+20% HP) |
//  💀 Проклятия: Слабая рука (−15% урона и лечения), Магнит для ударов (босс бьёт ×2 чаще) | !атака !навык !особый»
export function renderJoinInfo(player, config = CONFIG) {
  const cls = config.PLAYER_CLASSES[player.classId];
  // У neutral и у фиксированной стихии класса (хиллер) значка нет.
  const showElement = player.element !== 'neutral' && player.element !== cls.fixedElement;
  const element = showElement ? ` ${config.DAMAGE_TYPES[player.element].emoji}` : '';

  const parts = [
    `@${player.displayName}, ты ${cls.emoji} ${cls.name}${element}`,
    `❤️ ${player.hp}/${player.maxHp}`,
    `🔷 ${player.mana}/${player.maxMana}`,
  ];
  if (player.status === 'downed') {
    parts.push(`😵 без сознания, встанет через ${player.downedTurnsLeft} ${plural(player.downedTurnsLeft, TURN_FORMS)}`);
  }
  if (player.personalSkill) {
    const { skillId, rarity } = player.personalSkill;
    const cd = player.cooldowns?.personal ?? 0;
    const state = cd > 0 ? `, откат ${cd}` : '';
    parts.push(`✨ Особый: ${getSkillDef(skillId, config).name} (${config.PERSONAL_SKILLS.RARITIES[rarity].name}${state})`);
  } else {
    parts.push('✨ Особый: —');
  }
  if (player.traits) {
    const show = (id) => {
      const def = getTraitDef(id, config);
      return `${def.name} (${describeTrait(def)})`;
    };
    parts.push(`🎁 Дар: ${show(player.traits.gift)}`);
    parts.push(`💀 Проклятия: ${player.traits.curses.map(show).join(', ')}`);
  }
  parts.push('!атака !навык !особый');
  return clip(parts.join(' | '), 500);
}

// Для !я — тот же формат, что renderJoinInfo, с текущими HP, маной, откатом и статусом.
export function renderPlayerStatus(player, config = CONFIG) {
  return renderJoinInfo(player, config);
}

// «В бой идут: 🛡️ 5 воинов, 🔮 3 мага…»
export function renderRoster(registry, config = CONFIG) {
  const counts = {};
  for (const player of registry.values()) {
    counts[player.classId] = (counts[player.classId] || 0) + 1;
  }

  const groups = Object.entries(config.PLAYER_CLASSES)
    .filter(([id]) => counts[id] > 0)
    .map(([id, cls]) => `${cls.emoji} ${counts[id]} ${plural(counts[id], cls.plural)}`);

  if (groups.length === 0) return 'В бой пока никто не идёт';
  return clip(`В бой идут: ${groups.join(', ')}`, 500);
}
