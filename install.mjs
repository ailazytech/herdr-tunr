#!/usr/bin/env node
// 把 tunr mod 裝進 herdr App：node install.mjs
// 只複製 mods/tunr 到 ~/.config/herdr-app/mods/tunr（config.json 不動），mod.json 先複製（App 開著時 main.js 先到會自動塞進 layout）。
// 不改任何 layout。需要 Node 18+、ffmpeg／ffplay／ffprobe 在 PATH 上。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appHome = process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app')
if (!fs.existsSync(appHome)) {
  console.error('找不到 herdr App 的資料夾：' + appHome + '（先裝好並開過一次 herdr App）')
  process.exit(1)
}
for (const tool of ['ffmpeg', 'ffplay', 'ffprobe']) {
  try { execFileSync(tool, ['-version'], { stdio: 'ignore' }) } catch { console.warn('提醒：PATH 上找不到 ' + tool + '，tunr 播不出來') }
}
const source = path.join(here, 'mods', 'tunr')
const target = path.join(appHome, 'mods', 'tunr')
fs.mkdirSync(target, { recursive: true })
const names = fs.readdirSync(source).sort((a, b) => (b === 'mod.json') - (a === 'mod.json'))
for (const name of names) fs.copyFileSync(path.join(source, name), path.join(target, name))
console.log('已安裝 mod：' + target)
console.log('開啟：herdr-app do mod.open --name tunr（再一次會關掉），或 herdr-quota 狀態列的 tunr 按鈕；設定放 ' + path.join(target, 'config.json'))
