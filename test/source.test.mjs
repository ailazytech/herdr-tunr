import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsYtDlp } from '../mods/tunr/source.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
test('extract pages but not local files or direct media links', () => {
  for (const src of ['https://www.youtube.com/watch?v=abc', 'https://example.com/watch/12']) assert.equal(needsYtDlp(src), true, src);
  for (const src of ['C:/Videos/a.mp4', '/tmp/file', 'https://example.com/VIDEO.MP4?token=123', 'https://example.com/a.mp3', 'https://example.com/a.m3u8']) assert.equal(needsYtDlp(src), false, src);
});
test('missing yt-dlp is reported to the window', { timeout: 10000 }, async () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['mods/tunr/tunr.mjs', '--source', 'https://www.youtube.com/watch?v=abc', '--port', String(port)], { env: { ...process.env, PATH: '' }, stdio: 'ignore' });
  let socket;
  try {
    for (let i = 0; i < 60; i++) {
      const candidate = net.connect(port, '127.0.0.1');
      try { await once(candidate, 'connect'); socket = candidate; break; } catch { candidate.destroy(); await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(socket, 'engine did not start');
    const [data] = await once(socket, 'data');
    const status = JSON.parse(data.toString('latin1').split('\f')[0].slice(1));
    assert.equal(status.error, 'missingYtDlp');
    socket.write('{"cmd":"quit"}\n');
    await once(child, 'exit');
  } finally { socket?.destroy(); if (child.exitCode === null) child.kill(); }
});
