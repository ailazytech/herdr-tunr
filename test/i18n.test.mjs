import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messages, t, language, initLanguage } from '../mods/tunr/i18n.js';
test('translation keys and fallback and interpolation', () => {
  assert.deepEqual(Object.keys(messages['zh-TW']).sort(), Object.keys(messages.en).sort());
  assert.equal(t('missingYtDlp', { command: 'abc' }, 'zh-TW'), '需要 yt-dlp：abc');
  assert.equal(t('play', {}, 'unknown'), 'Play');
  assert.equal(t('unknown'), 'unknown');
});
test('shared language and detection', async () => {
  const state = {}; const get = key => state[key]; const set = (key, value) => { state[key] = value; };
  await initLanguage(get, set, async () => ({ code: 0, stdout: 'zh-Hant-TW\n' }));
  assert.equal(language(get), 'zh-TW'); state['ui.language'] = 'en'; assert.equal(language(get), 'en');
  await initLanguage(get, set, () => { throw Error('must not redetect'); });
  assert.equal(state['ui.system-language'], 'zh-TW');
});
