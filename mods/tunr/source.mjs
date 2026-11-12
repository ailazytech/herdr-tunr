// Direct media URLs bypass yt-dlp; other HTTP(S) pages go through its extractors.
export function needsYtDlp(source) {
  try {
    const url = new URL(source)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return !/\.(?:mp4|m4v|mov|webm|mkv|avi|mp3|m4a|aac|wav|ogg|opus|flac|m3u8|mpd)$/i.test(url.pathname)
  } catch { return false }
}
