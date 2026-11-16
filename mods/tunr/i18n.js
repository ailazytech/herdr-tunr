export const messages = {
  'zh-TW': { connecting: '連線中…', drop: '把影音檔拖進來', engineEnded: '引擎已結束', connectFailed: '連不上引擎', resolveFailed: '無法取得串流網址', playFailed: '無法播放串流', missingYtDlp: '需要 yt-dlp：{command}', copyCommand: '複製指令', copied: '已複製', confirm: '確定', urlPlaceholder: '輸入網址，按 Enter 播放', url: '輸入網址', play: '播放', pause: '暫停', prevTrack: '上一首', nextTrack: '下一首', volumeDown: '降低音量', volumeUp: '提高音量', volumeValue: '音量 {value}%', speedValue: '播放速度 {value}×（右鍵往回）', video: '畫面', videoHelp: '開關畫面', low: '低彩', mono: '黑白', mode: '切換色彩', size: '切換尺寸', smaller: '縮小', bigger: '放大', opacity: '背景透明度', opacityValue: '背景透明度 {value}%', audioMode: '音訊模式', fps: '顯示 FPS', close: '關閉', systemAudio: '電腦的聲音', systemAudioTip: '顯示電腦正在播的聲音', systemAudioOn: '接瀏覽器（電腦的聲音）', systemAudioOff: '改回 tunr 播放', windowsOnly: '目前只支援 Windows', noRoom: '{size} 放不下，先把視窗往左上拖', eqOn: '顯示等化器', eqOff: '隱藏等化器', listUnavailable: '抓不到這個清單（可能是私人清單或已刪除）' },
  en: { connecting: 'Connecting…', drop: 'Drop a media file here', engineEnded: 'Engine stopped', connectFailed: 'Could not connect to engine', resolveFailed: 'Could not retrieve stream URL', playFailed: 'Could not play stream', missingYtDlp: 'yt-dlp required: {command}', copyCommand: 'Copy command', copied: 'Copied', confirm: 'Done', urlPlaceholder: 'Enter a URL and press Enter', url: 'Enter URL', play: 'Play', pause: 'Pause', prevTrack: 'Previous track', nextTrack: 'Next track', volumeDown: 'Volume down', volumeUp: 'Volume up', volumeValue: 'Volume {value}%', speedValue: 'Playback speed {value}× (right-click for previous)', video: 'Video', videoHelp: 'Toggle video', low: 'Color', mono: 'Mono', mode: 'Change color mode', size: 'Change size', smaller: 'Smaller', bigger: 'Bigger', opacity: 'Background opacity', opacityValue: 'Background opacity {value}%', audioMode: 'Audio only', fps: 'Show FPS', close: 'Close', systemAudio: 'System audio', systemAudioTip: 'Show what this computer is playing', systemAudioOn: 'Capture browser (system audio)', systemAudioOff: 'Switch back to tunr playback', windowsOnly: 'Currently Windows only', noRoom: 'No room for {size}; drag the window up and left first', eqOn: 'Show equalizer', eqOff: 'Hide equalizer', listUnavailable: "Couldn't load this playlist (it may be private or deleted)" }
};
export function t(key, vars = {}, language = 'en') {
  return (messages[language]?.[key] ?? messages.en[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}
export function language(shared) {
  const selected = shared('ui.language') ?? 'auto';
  return selected === 'auto' ? (shared('ui.system-language') ?? 'en') : selected;
}
export async function initLanguage(shared, setShared, exec) {
  if (shared('ui.system-language') != null) return;
  let detected = 'en';
  try { const r = await exec('node', ['-p', 'Intl.DateTimeFormat().resolvedOptions().locale']); if (r.code === 0 && /^zh/i.test(r.stdout.trim())) detected = 'zh-TW'; } catch {}
  if (shared('ui.system-language') == null) setShared('ui.system-language', detected);
}
