import { CONFIG } from './config.js';
import { hashKey } from './hash.js';

// Стихия на бой: детерминированно по (battleId, userId), без общего rng.
// Класс с fixedElement (хиллер) стихию не получает.
export function assignElement(battleId, userId, classId, config = CONFIG) {
  const fixed = config.PLAYER_CLASSES[classId]?.fixedElement;
  if (fixed) return fixed;

  const u = hashKey(battleId, userId);
  let cumulative = 0;
  for (const [element, chance] of Object.entries(config.ELEMENT_CHANCES)) {
    cumulative += chance;
    if (u < cumulative) return element;
  }
  return 'neutral';
}

// Класс на бой: детерминированно по (battleId, userId) с солью «class», веса из CLASS_WEIGHTS.
// Перезаход и выход класс не меняют, смены класса нет.
export function assignClass(battleId, userId, config = CONFIG) {
  const entries = Object.entries(config.CLASS_WEIGHTS).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  const target = hashKey(battleId, userId, config.CLASS_SALT) * total;
  let cumulative = 0;
  for (const [classId, w] of entries) {
    cumulative += w;
    if (target < cumulative) return classId;
  }
  return entries[entries.length - 1][0];
}

// Тип урона игрока: стихия, а при neutral — родной тип класса.
export function playerDamageType(player, config = CONFIG) {
  if (!player.element || player.element === 'neutral') {
    return config.PLAYER_CLASSES[player.classId].nativeDamageType;
  }
  return player.element;
}
