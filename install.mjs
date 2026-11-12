#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

export const tools = ['ffmpeg', 'ffplay', 'ffprobe', 'yt-dlp']
export function missingTools(check) { return tools.filter(tool => !check(tool)) }
export function installCommands(missing, platform = process.platform) {
  const ff = missing.some(x => x !== 'yt-dlp'), yt = missing.includes('yt-dlp')
  if (platform === 'win32') return [...(ff ? [{ command: 'winget', args: ['install', 'Gyan.FFmpeg'] }] : []), ...(yt ? [{ command: 'winget', args: ['install', 'yt-dlp.yt-dlp'] }] : [])]
  if (platform === 'darwin') return ff || yt ? [{ command: 'brew', args: ['install', ...(ff ? ['ffmpeg'] : []), ...(yt ? ['yt-dlp'] : [])] }] : []
  if (platform === 'linux') return [...(ff ? [{ command: 'sudo', args: ['apt', 'install', 'ffmpeg'], manual: true }] : []), ...(yt ? [{ command: 'pipx', args: ['install', 'yt-dlp'] }] : [])]
  return []
}
export async function assist({ check, platform = process.platform, yes = false, tty = false, ask = async () => '', run = () => {}, log = console.log }) {
  const missing = missingTools(check)
  if (!missing.length) { log('工具齊全：ffmpeg、ffplay、ffprobe、yt-dlp'); return missing }
  log('缺少工具：' + missing.join('、'))
  const commands = installCommands(missing, platform)
  if (!commands.length) log('請依作業系統安裝缺少的工具。')
  for (const item of commands) log((item.manual ? '請手動執行：' : '安裝指令：') + [item.command, ...item.args].join(' '))
  const automatic = commands.filter(item => !item.manual)
  let accepted = yes
  if (!yes && tty && automatic.length) accepted = !/^n(?:o)?$/i.test((await ask('要現在安裝嗎？[Y/n] ')).trim())
  if (accepted) {
    for (const item of automatic) run(item.command, item.args)
    const remaining = missingTools(check)
    log(remaining.length ? '重新檢查仍缺少：' + remaining.join('、') : '重新檢查：工具齊全')
    log('新開的終端機才會讀到新的 PATH；herdr 的新終端會自動更新，tunr 不用重開 App。')
    return remaining
  }
  return missing
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const appHome = process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app')
  if (!fs.existsSync(appHome)) { console.error('找不到 herdr App 的資料夾：' + appHome + '（先裝好並開過一次 herdr App）'); process.exitCode = 1; return }
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null
  try {
    await assist({ check: tool => spawnSync(tool, [tool === 'yt-dlp' ? '--version' : '-version'], { stdio: 'ignore', windowsHide: true }).status === 0, yes: process.argv.includes('--yes'), tty: Boolean(rl), ask: q => rl.question(q), run: (cmd, args) => { const result = spawnSync(cmd, args, { stdio: 'inherit' }); if (result.error || result.status !== 0) console.error('安裝指令失敗：' + cmd) } })
  } finally { rl?.close() }
  const source = path.join(here, 'mods', 'tunr'), target = path.join(appHome, 'mods', 'tunr')
  fs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(source).sort((a, b) => (b === 'mod.json') - (a === 'mod.json'))) if (name !== 'config.json') fs.copyFileSync(path.join(source, name), path.join(target, name))
  console.log('已安裝 mod：' + target)
  console.log('開啟：herdr-app do mod.open --name tunr；設定放 ' + path.join(target, 'config.json'))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
