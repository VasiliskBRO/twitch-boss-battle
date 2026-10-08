import { CONFIG } from './src/config.js';
import { createPlayer, buildPlayer } from './src/players.js';
import { getSkillWeights, getSkillDef, renderPersonalSkill, skillsForClass } from './src/personal_skills.js';
import { getTraitDef, renderTraits } from './src/traits.js';
import { renderPlayerStatus, renderRoster } from './src/renderer.js';

// Фиксированные боссы (навыки из каталога части 1), чтобы вывод был воспроизводимым.
const DRAGON = {
  name: 'Древний Дракон Бездны', archetype: 'dragon', weakness: 'ice', resistance: 'fire', currentPhase: 1,
  skills: [
    { name: 'Драконий укус', kind: 'single' },
    { name: 'Огненное дыхание', kind: 'aoe' },
    { name: 'Раздирающий коготь', kind: 'single' },
    { name: 'Алмазная чешуя', kind: 'buff', effect: 'armor' },
  ],
};
const GOLEM = {
  name: 'Каменный Голем Подземелий', archetype: 'golem', weakness: 'magic', resistance: 'physical', currentPhase: 1,
  skills: [
    { name: 'Дробящий удар', kind: 'single' },
    { name: 'Землетрясение', kind: 'aoe' },
    { name: 'Каменные оковы', kind: 'debuff', effect: 'weaken' },
    { name: 'Укрепление', kind: 'buff', effect: 'armor' },
  ],
};
const CLASSES = Object.keys(CONFIG.PLAYER_CLASSES);
const BATTLE = 'demo-battle-1';
const pct = (v) => `${(v * 100).toFixed(1)}%`.padStart(6);

// ---------- 1. Таблицы весов навыков ----------
function printWeights(boss) {
  const kinds = boss.skills.map((s) => `${s.name} (${s.kind}${s.effect ? `, ${s.effect}` : ''})`).join(', ');
  console.log(`\n### ${boss.name} | архетип ${boss.archetype} | слабость ${boss.weakness} | сопротивление ${boss.resistance}`);
  console.log(`Навыки босса: ${kinds}`);
  for (const classId of CLASSES) {
    const cls = CONFIG.PLAYER_CLASSES[classId];
    // Стихии, дающие разные веса: neutral и та, что совпадает с сопротивлением (компенсатор ×3).
    const elements = classId === 'healer' ? ['holy'] : [...new Set(['neutral', boss.resistance])].filter((e) => e in CONFIG.ELEMENT_CHANCES);
    for (const element of elements) {
      const p = createPlayer('demo', 'demo', classId, BATTLE);
      p.element = element;
      const weights = getSkillWeights(boss, p);
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      console.log(`  ${cls.emoji} ${cls.name}, стихия ${element}:`);
      for (const skill of skillsForClass(classId)) {
        const w = weights[skill.id];
        console.log(`      ${skill.name.padEnd(24)} вес ${String(+w.toFixed(2)).padStart(5)}  доля ${pct(w / total)}`);
      }
    }
  }
}
console.log('=== 1. ВЕСА ЛИЧНЫХ НАВЫКОВ ===');
printWeights(DRAGON);
printWeights(GOLEM);

// ---------- 2. 8 тестовых игроков ----------
console.log('\n=== 2. 8 ИГРОКОВ (бой с драконом) ===');
const registry = new Map();
const names = ['Ворон', 'Ёжик_TV', 'NightOwl', 'кот_учёный', 'Strelok', 'Магистр', 'ДобрыйДоктор', 'paladin_77'];
names.forEach((name, i) => {
  const player = buildPlayer(BATTLE, `uid-${1000 + i}`, name, CLASSES[i % 4], { boss: DRAGON }); // класс задан для наглядности; в бою его выдаёт хеш
  registry.set(player.userId, player);
  if (i === 5) player.cooldowns.personal = 2; // показать «Откат»
  if (i === 6) player.hp = Math.round(player.maxHp * 0.4);
});
console.log(renderRoster(registry));
for (const p of registry.values()) {
  const status = renderPlayerStatus(p);
  const skill = renderPersonalSkill(p);
  const traits = renderTraits(p);
  console.log(`\n!я  [${status.length}] ${status}`);
  console.log(`    [${skill.length}] ${skill}`);
  console.log(`    [${traits.length}] ${traits}`);
}

// ---------- 3. Сводка по 1000 игрокам ----------
console.log('\n=== 3. РАСПРЕДЕЛЕНИЕ ЧЕРТ ПО 1000 ИГРОКАМ (по 250 на класс, бой с драконом) ===');
const traitCounts = Object.fromEntries(CONFIG.TRAITS.map((t) => [t.id, Object.fromEntries(CLASSES.map((c) => [c, 0]))]));
const rarityCounts = { common: 0, rare: 0, epic: 0 };
const skillCounts = {};
for (let i = 0; i < 1000; i++) {
  const classId = CLASSES[i % 4];
  const player = buildPlayer(BATTLE, `viewer-${i}`, `v${i}`, classId, { boss: DRAGON });
  for (const id of [player.traits.gift, ...player.traits.curses]) traitCounts[id][classId]++;
  rarityCounts[player.personalSkill.rarity]++;
  skillCounts[player.personalSkill.skillId] = (skillCounts[player.personalSkill.skillId] || 0) + 1;
}
console.log(`  ${'Черта'.padEnd(24)} ${'тип'.padEnd(9)} ${CLASSES.map((c) => CONFIG.PLAYER_CLASSES[c].name.padStart(7)).join(' ')}   всего`);
for (const t of CONFIG.TRAITS) {
  const row = CLASSES.map((c) => String(traitCounts[t.id][c] || '—').padStart(7)).join(' ');
  const total = Object.values(traitCounts[t.id]).reduce((a, b) => a + b, 0);
  console.log(`  ${t.name.padEnd(24)} ${(t.polarity === 'gift' ? 'дар' : 'проклятие').padEnd(9)} ${row}   ${String(total).padStart(5)}`);
}
console.log('  (в столбце класса: сколько из 250 игроков класса получили черту; «—» — черта классу недоступна)');
console.log(`\n  Редкость личных навыков: ${Object.entries(rarityCounts).map(([r, n]) => `${CONFIG.PERSONAL_SKILLS.RARITIES[r].name} ${n}`).join(', ')}`);
console.log(`  Навыки: ${Object.entries(skillCounts).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${getSkillDef(id).name} ${n}`).join(', ')}`);
// Используем getTraitDef, чтобы демо падало на битом каталоге.
CONFIG.TRAITS.forEach((t) => getTraitDef(t.id));
