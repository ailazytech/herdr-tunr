# herdr-tunr

English ｜ [繁體中文](README.md)

A small floating player for the [herdr app](https://herdr.dev): a video becomes ASCII in a corner, to watch or just listen while you work.

herdr is the herder, [tendr](https://github.com/ailazytech/tendr) tends the fire, [ranchr](https://github.com/ailazytech/herdr-ranchr) runs the ranch, and tunr is the tuner.

- **Small:** 48×16 characters by default, or medium (64×22) and large (80×27); drag it anywhere, and it comes back where you left it after a restart
- **Black and white, or low color:** low color uses only 8 muted colors, so it doesn't pull your eye from your work
- **Screen off:** keep just the sound and a control bar; nothing is redrawn
- **Sources:** local files, direct links (mp4, mp3…) or YouTube and other sites supported by yt-dlp; drop a file or press 🔗 to enter a URL

## You need

- The herdr app (installed and opened once), Node.js 18 or later
- `ffmpeg`, `ffplay` and `ffprobe` on the PATH; YouTube and similar sites also need `yt-dlp`

## Install

```bash
git clone https://github.com/ailazytech/herdr-tunr
node herdr-tunr/install.mjs
```

Installs only `~/.config/herdr-app/mods/tunr/` and changes no layout; your `config.json` is never overwritten. To update, `git pull` and run it again.
The installer checks the tools and offers installation commands. In an interactive terminal it can run them; `--yes` runs eligible commands without asking. Linux sudo commands must be run manually. A new terminal picks up PATH changes; herdr refreshes its new terminals automatically, so the app need not be restarted.

## Open it

- With [herdr-quota](https://github.com/ailazytech/herdr-quota) installed, the bottom bar has a **tunr** button: click to open, again to close
- Or `herdr-app do mod.open --name tunr` (again closes it)
- For a key, add `"ctrl-alt-t": "mod.open:tunr"` to `global` in `keys.json`

## Controls

The bar at the bottom of the window: play / pause, the progress bar (click to jump), volume − / +, screen on / off, black and white / low color, S / M / L, ✕ to close.
Press 🔗 to open the URL field. An HTTP(S) URL on the clipboard is filled in and selected automatically; press Enter to play, or edit or clear it. The language setting is shared with ranchr and herdr-quota; use `tunr.language-auto`, `tunr.language-zh` or `tunr.language-en` to change it.

Commands (`herdr-app do tunr.<command>`, or `tunr.<command>` in `keys.json`): `toggle` (play / pause), `video` (screen on / off), `mode`, `size`, `close`.

## Settings

`~/.config/herdr-app/mods/tunr/config.json`, optional:

```json
{ "source": "C:/Videos/a.mp4", "size": "S", "mode": "mono", "video": true, "volume": 80, "debug": false }
```

- `source`: what to play on opening; without it, the window waits for a file to be dropped
- `size`: `S`, `M`, `L`; `mode`: `mono` or `low`; `video`: `false` to only listen
- `debug`: `true` adds an FPS button and writes what it measures to `~/.config/herdr-app/data/tunr-stats.json` every 2 seconds

## How it works

- The picture is made by a background engine (`tunr.mjs`): ffmpeg scales the video to a grid of characters and turns it into ASCII, ffplay plays the sound, and frames go to the window one by one over local TCP (`127.0.0.1`); the window only draws and controls
- The engine runs in a background terminal named `tunr-engine`; closing the window ends it, and so do 15 seconds with nobody connected
- Sound is the clock: the picture follows it and late frames are dropped, so it never falls behind
- Measured on Windows at 24 frames a second, small window: black and white takes about 0.7 ms per redraw with no frames dropped; low color draws about 100 runs of text per frame at about 23 frames a second

## Limits

- Pausing, seeking, changing the volume or the mode restarts the background programs, with a 0.2–0.5 s gap
- No Spotify or podcast search; site playback depends on yt-dlp and the source's restrictions

## Remove

Close the window and delete `~/.config/herdr-app/mods/tunr/`.

## License

[MIT](LICENSE)
