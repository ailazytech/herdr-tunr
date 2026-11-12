import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingTools, installCommands, assist } from '../install.mjs';
test('missing tools and commands by platform', () => {
  assert.deepEqual(missingTools(x => x !== 'yt-dlp'), ['yt-dlp']);
  assert.deepEqual(installCommands(['ffmpeg', 'ffplay', 'yt-dlp'], 'win32').map(x => [x.command, ...x.args].join(' ')), ['winget install Gyan.FFmpeg', 'winget install yt-dlp.yt-dlp']);
  assert.equal(installCommands(['ffmpeg', 'yt-dlp'], 'darwin')[0].args.join(' '), 'install ffmpeg yt-dlp');
  assert.deepEqual(installCommands(['ffmpeg', 'yt-dlp'], 'linux').map(x => [x.command, ...x.args].join(' ')), ['sudo apt install ffmpeg', 'pipx install yt-dlp']);
});
test('noninteractive and Linux never automatically run sudo', async () => {
  const ran = [], output = [];
  await assist({ check: () => false, platform: 'linux', yes: true, run: (...args) => ran.push(args), log: x => output.push(x) });
  assert.deepEqual(ran, [['pipx', ['install', 'yt-dlp']]]); assert.match(output.join('\n'), /請手動執行：sudo apt install ffmpeg/);
  ran.length = 0; await assist({ check: () => false, platform: 'win32', tty: false, run: (...args) => ran.push(args), log: () => {} }); assert.equal(ran.length, 0);
});
test('interactive answer and recheck', async () => {
  let installed = false; const output = [];
  const remaining = await assist({ check: x => x !== 'yt-dlp' || installed, platform: 'win32', tty: true, ask: async () => 'Y', run: () => { installed = true; }, log: x => output.push(x) });
  assert.deepEqual(remaining, []); assert.match(output.join('\n'), /重新檢查：工具齊全/);
});
