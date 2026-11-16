# herdr-tunr

English ｜ [繁體中文](README.md)

A small floating player for the [herdr app](https://herdr.dev): a video becomes ASCII in a corner, to watch or just listen while you work.

herdr is the herder, [tendr](https://github.com/ailazytech/tendr) tends the fire, [ranchr](https://github.com/ailazytech/herdr-ranchr) runs the ranch, and tunr is the tuner.

- **Small:** 48×16 characters by default, or medium (64×22) and large (80×27); drag it anywhere, and it comes back where you left it after a restart
- **Black and white, or low color:** low color uses only 8 muted colors, so it doesn't pull your eye from your work
- **Screen off:** keep just the sound in a compact two-row panel; nothing is redrawn
- **System audio spectrum:** press 📻 to show a live dancing ASCII spectrum of whatever this computer is playing (Spotify, browser, games...)
- **Sources:** local files, direct links (mp4, mp3…), YouTube and other sites supported by yt-dlp, or system audio; drop a file, press 🔗 to enter a URL, or press 📻 to switch to system audio

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

Top header bar: displays the active source name (or "Title — Artist" in system audio mode; temporary notices such as no-room warnings replace the title text; hover a title cut off with "…" to see all of it), with Smaller / Bigger / Close buttons on the right; drag empty areas of the header or background to move the window.
Bottom control bar: Row 1 holds play / pause, previous / next track, progress bar (click or drag to seek), and elapsed / total time; Row 2 holds playback speed on the left (fixed-width `1×` text button supporting `0.75×`, `1×`, `1.25×`, `1.5×`, `2×`; left-click for next, right-click for previous, highlighted when not `1×`, hidden in 📻 system audio mode), and on the right: system audio (toggles back and forth between system audio and the previous source), URL input, screen on / off, black and white / low color toggle, volume (tooltip shows the current percentage; clicking opens a 0%–100% slider in steps of 5, mutually exclusive with URL input and opacity slider, hidden in 📻 mode), and background opacity (opens a draggable 5%–100% slider that adjusts only the window background while keeping text and icons crisp).
When screen-off (audio-only) mode is active, the window shrinks to a ~64px tall two-row compact panel (ordering: `audio-only < S < M < L`): a translucent real-time equalizer draws behind the entire panel (for both 📻 system audio and tunr file/URL playback, matching mono/low-color and theme, and falling smoothly when paused; toggle with the equalizer button in the second row or the `tunr.eq` command; the choice is remembered), Row 1 adds elapsed/total time to the left of the window controls when space permits, a thin clickable/draggable seek line separates the rows (omitted in system audio mode), and Row 2 shows a single row of controls (keeping play, previous / next track, speed, and placing the volume button between the equalizer and opacity buttons while omitting the mono/low-color toggle). Opening the URL field, volume slider, or opacity slider in compact mode replaces Row 2 inline with a percentage/input and confirm (`✓`) button. `smaller` from `S` enters audio-only mode while preserving width; `bigger` from audio-only reopens video at that width (showing a temporary Row 1 notice if it does not fit).
For tunr's own sources (🔗 URL or dropped local file), **Previous / Next** and **auto-advance** are supported: dropping a local media file scans sibling media files in the same folder sorted naturally (e.g. `a2` before `a10`); YouTube URLs with a playlist (`list=`, including `RD…` mixes) fetch the list in the background via `yt-dlp --flat-playlist` without blocking playback (buttons stay greyed out until loaded) and match `v=` to find the current position, building `watch?v=<id>&list=<listId>` URLs so reopening tunr restores the playlist; single files or single URLs with no previous/next track keep the buttons greyed out; if the playlist cannot be loaded (for example a private playlist, which yt-dlp cannot see without signing in) the buttons stay greyed out and their tooltip explains why — making the playlist Unlisted fixes it. Pressing Previous past 3 seconds seeks back to the start of the current track; within 3 seconds it jumps to the previous track. When a track finishes naturally (manual pause does not count) and a next track exists, tunr automatically starts the next track and stops at the last one; switching tracks preserves speed, volume, equalizer, video on/off, and window size, while playback failures (`playFailed`, `resolveFailed`) stop and display the error rather than skipping ahead.
When switching to system audio spectrum (single `system.ps1` PowerShell process), the previous file or URL (`lastSource`) is remembered so clicking 📻 again switches back to it (or resets to the drop prompt if none). The seek bar / seek line, volume, and speed controls are hidden; on Windows, when an active system media session is detected, "Title — Artist" appears in the header, play / pause controls that media, and previous / next buttons appear when supported (when no session is active, play / pause freezes / unfreezes the visual). When opening the URL field, an HTTP(S) URL on the clipboard is filled in and selected automatically; press Enter or Done (`✓`) to play, or edit or clear it. The language setting is shared with ranchr and herdr-quota; use `tunr.language-auto`, `tunr.language-zh` or `tunr.language-en` to change it.

Commands (`herdr-app do tunr.<command>`, or `tunr.<command>` in `keys.json`): `toggle` (play / pause), `prev` (previous track: 3-second rule on playlist/folder for tunr sources, or browser in system audio mode), `next` (next track: playlist/folder for tunr sources, or browser in system audio mode), `volume-up` / `volume-down` (adjust volume), `speed` (cycle playback speed `1 → 1.25 → 1.5 → 2 → 0.75 → 1`), `video` (screen on / off), `eq` (compact background equalizer on / off), `mode`, `size` (cycle audio-only / S / M / L), `smaller` (shrink; S enters audio-only), `bigger` (grow; audio-only reopens video), `opacity` (step background opacity `100 → 75 → 50 → 25 → 10 → 5 → 100`), `system` (toggle system audio), `system-on` (switch to system audio), `system-off` (switch back from system audio), `close`.

## Settings

`~/.config/herdr-app/mods/tunr/config.json`, optional:

```json
{ "source": "system", "size": "S", "mode": "mono", "video": true, "eq": true, "volume": 80, "speed": 1, "opacity": 100, "debug": false }
```

- `source`: what to play on opening; `"system"` starts in system audio spectrum mode; without it, the window waits for a file to be dropped
- `lastSource`: the previous file or URL remembered before switching to `"system"`, used when toggling 📻 off
- `size`: `S`, `M`, `L`; `mode`: `mono` or `low`; `video`: `false` to only listen; `eq`: show translucent background equalizer in compact mode (default `true`); `speed`: playback speed (`0.75`, `1`, `1.25`, `1.5`, or `2`, default `1`; applies to files/URLs played by tunr); `opacity`: background opacity percent (`5`–`100`, default `100`)
- `debug`: `true` adds an FPS button and writes what it measures to `~/.config/herdr-app/data/tunr-stats.json` every 2 seconds

Changes made in the window—volume, speed, mode (`mono`/`low`), size, video on/off, compact equalizer (`eq`), background opacity, and the active source (dropped file, URL, system audio, and `lastSource`)—are automatically saved to `~/.config/herdr-app/data/tunr/settings.json` (playback position is not saved); `config.json` holds your manual defaults (`install.mjs` never overwrites it, and cleans up legacy `loopback.ps1` / `media.ps1`), and deleting `settings.json` resets back to those defaults. The background engine also shuts down automatically if no window connects within 60 seconds after listening.

## How it works

- The picture is made by a background engine (`tunr.mjs`): ffmpeg scales the video to a grid of characters and turns it into ASCII, ffplay plays the sound, and frames go to the window one by one over local TCP (`127.0.0.1`); the window only draws and controls
- The engine runs in a background terminal named `tunr-engine`; closing the window ends it, and so do 60 seconds after startup without a connection or 15 seconds with nobody connected
- Sound is the clock: the picture follows it and late frames are dropped, so it never falls behind
- Measured on Windows at 24 frames a second, small window: black and white takes about 0.7 ms per redraw with no frames dropped; low color draws about 100 runs of text per frame at about 23 frames a second

## Limits

- System audio spectrum currently supports Windows only (captures audio from the default playback device); macOS and Linux are not supported yet
- Pausing, seeking, or changing the mode (or changing the volume when ffmpeg lacks the `azmq` filter) restarts the background programs with a 0.2–0.5 s gap; when `azmq` is available, volume changes apply live without interruption
- No Spotify or podcast search; site playback depends on yt-dlp and the source's restrictions

## Remove

Close the window and delete `~/.config/herdr-app/mods/tunr/`.

## License

[MIT](LICENSE). In `mods/tunr/icons/`, `close.svg`, `bigger.svg` and `smaller.svg` come from [Lucide](https://lucide.dev) (ISC; derived from Feather, MIT); the full license is in [`mods/tunr/icons/LICENSE-Lucide.txt`](mods/tunr/icons/LICENSE-Lucide.txt). The other icons were drawn for this project and are MIT.
