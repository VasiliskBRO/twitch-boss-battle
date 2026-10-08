import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../../src/config.js';
import { normalizeMessage, rolesFromBadges, MessageDeduper, SerialProcessor } from '../../twitch/inbound.js';
import { rawFromTwurpleEvent } from '../../twitch/twurple_adapter.js';
import { parseConsoleLine } from '../../twitch/console_input.js';
import { createLogger } from '../../twitch/logger.js';
import { saveBattle, loadBattle, writeFileAtomic } from '../../twitch/persistence.js';

const T = CONFIG.TWITCH;
const raw = (over = {}) => ({
  userId: '111', userLogin: 'anna', displayName: 'Anna', text: '!join', badges: {}, messageId: 'm1', channelId: '999', sourceChannelId: null, ...over,
});
const norm = (r, config = T) => normalizeMessage(r, { selfUserId: 'bot-id', config });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bot-'));

test('Нормализация: userId — числовой id, роли стримера, модератора и VIP', () => {
  const { event } = norm(raw());
  assert.deepStrictEqual(event, { userId: '111', displayName: 'Anna', text: '!join', roles: { broadcaster: false, moderator: false }, messageId: 'm1' });
  assert.strictEqual(norm(raw({ badges: { broadcaster: '1' } })).event.roles.broadcaster, true);
  assert.strictEqual(norm(raw({ userId: '999' })).event.roles.broadcaster, true, 'стример по совпадению id с каналом');
  assert.strictEqual(norm(raw({ badges: { moderator: '1' } })).event.roles.moderator, true);
  assert.strictEqual(norm(raw({ badges: { lead_moderator: '1' } })).event.roles.moderator, true);
  assert.strictEqual(norm(raw({ badges: { vip: '1' } })).event.roles.moderator, true, 'VIP считается модератором');
  assert.strictEqual(norm(raw({ badges: { vip: '1' } }), { ...T, vipCountsAsMod: false }).event.roles.moderator, false);
  assert.strictEqual(norm(raw({ displayName: '' })).event.displayName, 'anna');
});

test('Игнор: свои сообщения, без «!», исключённые боты, общий чат', () => {
  assert.strictEqual(norm(raw({ userId: 'bot-id' })).reason, 'self');
  assert.strictEqual(norm(raw({ text: 'привет всем' })).reason, 'notCommand');
  assert.strictEqual(norm(raw({ text: '  !join' })).reason, null);
  assert.strictEqual(norm(raw({ userLogin: 'Nightbot' })).reason, 'excluded');
  assert.strictEqual(norm(raw({ userId: 'nightbot' })).reason, 'excluded');
  assert.strictEqual(norm(raw({ sourceChannelId: '555' })).reason, 'sharedChat');
  assert.strictEqual(norm(raw({ sourceChannelId: '999' })).reason, null, 'источник — наш же канал');
  assert.strictEqual(norm(null).reason, 'invalid');
});

test('Повтор messageId в течение 60 с игнорируется', () => {
  let t = 0;
  const d = new MessageDeduper({ ttlMs: 60_000, now: () => t });
  assert.strictEqual(d.check('a'), true);
  assert.strictEqual(d.check('a'), false);
  assert.strictEqual(d.check('b'), true);
  t = 60_001;
  assert.strictEqual(d.check('a'), true, 'через 60 с кэш забывает');
  assert.strictEqual(d.check(null), true);
});

test('SerialProcessor: задачи строго по одной; ошибка не останавливает очередь', async () => {
  const errors = [];
  const s = new SerialProcessor({ log: { error: (m) => errors.push(m) } });
  const order = [];
  let active = 0;
  let maxActive = 0;
  const slow = (name, ms) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`начало ${name}`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`конец ${name}`);
    active--;
  };
  s.push(slow('A', 30));
  s.push(() => { throw new Error('сбой'); });
  s.push(slow('B', 5));
  await s.idle();
  assert.strictEqual(maxActive, 1);
  assert.deepStrictEqual(order, ['начало A', 'конец A', 'начало B', 'конец B']);
  assert.strictEqual(errors.length, 1);
});

test('Роли бота по значкам; событие Twurple → сырое сообщение', () => {
  assert.deepStrictEqual(rolesFromBadges({ moderator: '1' }), { broadcaster: false, moderator: true, vip: false });
  assert.deepStrictEqual(rolesFromBadges({ vip: '1' }), { broadcaster: false, moderator: false, vip: true });
  const e = { chatterId: '42', chatterName: 'anna', chatterDisplayName: 'Anna', messageText: '!я', badges: { vip: '1' }, messageId: 'x', sourceBroadcasterId: null };
  assert.deepStrictEqual(rawFromTwurpleEvent(e, '999'), {
    userId: '42', userLogin: 'anna', displayName: 'Anna', text: '!я', badges: { vip: '1' }, messageId: 'x', channelId: '999', sourceChannelId: null,
  });
});

test('Консольный режим: разбор «имя: текст», «@мод …», «@стример …»', () => {
  assert.deepStrictEqual(parseConsoleLine('аня: !join'), { name: 'аня', text: '!join', badges: {} });
  assert.deepStrictEqual(parseConsoleLine('@мод Боря: !стоп'), { name: 'Боря', text: '!стоп', badges: { moderator: '1' } });
  assert.deepStrictEqual(parseConsoleLine('@стример я: !карта 2'), { name: 'я', text: '!карта 2', badges: { broadcaster: '1' } });
  assert.deepStrictEqual(parseConsoleLine('!я'), { name: 'зритель', text: '!я', badges: {} });
});

test('Лог: ротация до 5 файлов по размеру, секреты вырезаются', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'bot.log');
  const log = createLogger({ file, maxBytes: 300, maxFiles: 5, now: () => 0 });
  log.addSecret('oauth-SECRET-123');
  log.info('токен oauth-SECRET-123 получен');
  for (let i = 0; i < 40; i++) log.info(`строка ${i} ${'x'.repeat(40)}`);
  const files = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(files, ['bot.log', 'bot.log.1', 'bot.log.2', 'bot.log.3', 'bot.log.4']);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!text.includes('SECRET'), f);
    assert.ok(fs.statSync(path.join(dir, f)).size <= 300);
  }
});

test('Сохранение боя: атомарно; свежий бой — resume, старый — stale, законченный — finished, битый — corrupt', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'battle.json');
  assert.deepStrictEqual(loadBattle(file, 0, 1000), { status: 'none' });

  saveBattle(file, JSON.stringify({ phase: 'running', turn: 3 }), 10_000);
  assert.ok(!fs.existsSync(`${file}.tmp`));
  const fresh = loadBattle(file, 10_000 + 20 * 60_000, 20 * 60_000);
  assert.strictEqual(fresh.status, 'resume');
  assert.strictEqual(JSON.parse(fresh.engineJson).turn, 3);

  assert.deepStrictEqual(loadBattle(file, 10_000 + 20 * 60_000 + 1, 20 * 60_000), { status: 'stale', hadBattle: true });
  assert.ok(!fs.existsSync(file), 'устаревший файл удалён');

  saveBattle(file, JSON.stringify({ phase: 'ended' }), 0);
  assert.strictEqual(loadBattle(file, 1, 1000).status, 'finished');

  writeFileAtomic(file, '{ сломано');
  assert.strictEqual(loadBattle(file, 0, 1000).status, 'corrupt');
  assert.ok(fs.existsSync(`${file}.corrupt`));
});
