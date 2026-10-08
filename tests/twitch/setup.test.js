import test from 'node:test';
import assert from 'node:assert';
import { normalizeChannelName, upsertEnv, readEnvValue, pollDeviceCode, nodeVersionOk } from '../../twitch/setup_lib.js';

test('Имя канала: ник, @ник, ссылка — всё приводится к логину', () => {
  assert.strictEqual(normalizeChannelName('Ninja'), 'ninja');
  assert.strictEqual(normalizeChannelName('  @VasiliskBRO '), 'vasiliskbro');
  assert.strictEqual(normalizeChannelName('https://www.twitch.tv/Some_Streamer/videos'), 'some_streamer');
  assert.strictEqual(normalizeChannelName('twitch.tv/abc?x=1'), 'abc');
  for (const bad of ['', 'ab', 'имя', 'a'.repeat(26), 'with space', null]) assert.strictEqual(normalizeChannelName(bad), null, String(bad));
});

test('.env: обновление значений с сохранением остального', () => {
  const before = '# комментарий\nTWITCH_CHANNEL=old\nOTHER=keep\n';
  const after = upsertEnv(before, { TWITCH_CHANNEL: 'new', BOT_USER_NAME: 'bot' });
  assert.strictEqual(after, '# комментарий\nTWITCH_CHANNEL=new\nOTHER=keep\nBOT_USER_NAME=bot\n');
  assert.strictEqual(upsertEnv('A=1\r\nB=2\r\n', { B: null }), 'A=1\n');
  assert.strictEqual(upsertEnv('', { X: 'y' }), '\nX=y\n'.trimStart());
  assert.strictEqual(readEnvValue(after, 'TWITCH_CHANNEL'), 'new');
  assert.strictEqual(readEnvValue(after, 'MISSING'), '');
});

test('Вход по коду: ждём, пока введут код; slow_down удлиняет паузу; отказ и тайм-аут — понятные ошибки', async () => {
  let t = 0;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); t += ms; };
  const pending = Object.assign(new Error('400'), { body: '{"status":400,"message":"authorization_pending"}' });
  const slow = Object.assign(new Error('400'), { body: '{"message":"slow_down"}' });
  const answers = [pending, pending, slow, { accessToken: 'ok' }];
  const token = await pollDeviceCode(async () => {
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a;
  }, { intervalSeconds: 5, expiresInSeconds: 600, sleep, now: () => t });
  assert.deepStrictEqual(token, { accessToken: 'ok' });
  assert.deepStrictEqual(sleeps, [5000, 5000, 10000]);

  const denied = Object.assign(new Error('400'), { body: '{"message":"access_denied"}' });
  await assert.rejects(pollDeviceCode(async () => { throw denied; }, { sleep, now: () => t }), /Доступ не выдан/);

  t = 0;
  await assert.rejects(pollDeviceCode(async () => { throw pending; }, { intervalSeconds: 5, expiresInSeconds: 12, sleep, now: () => t }), /Время на ввод кода вышло/);

  const other = new Error('сеть упала');
  await assert.rejects(pollDeviceCode(async () => { throw other; }, { sleep, now: () => 0 }), /сеть упала/);
});

test('Проверка версии Node.js', () => {
  assert.strictEqual(nodeVersionOk('20.0.0'), true);
  assert.strictEqual(nodeVersionOk('24.21.0'), true);
  assert.strictEqual(nodeVersionOk('18.19.1'), false);
});
