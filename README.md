# herdr-tunr

[English](README.en.md) ｜ 繁體中文

給 [herdr App](https://herdr.dev) 的小小懸浮播放器：影片在角落轉成 ASCII 畫面，一邊工作一邊看、一邊聽。

herdr 是牧人，[tendr](https://github.com/ailazytech/tendr) 顧爐火，[ranchr](https://github.com/ailazytech/herdr-ranchr) 管整座牧場，tunr 是調頻器。

- **小視窗**：預設 48×16 字，可以切中（64×22）、大（80×27）；拖得動，記得位置，App 重開後還在原處
- **黑白或低彩度**：低彩度只用 8 種壓低飽和度的顏色，不搶工作畫面的注意力
- **可關畫面**：只留聲音和一條控制列，畫面也不再重畫
- **系統音訊頻譜**：按 📻 顯示電腦正在播的聲音（Spotify、瀏覽器等）的即時跳動 ASCII 頻譜
- **來源**：本機影音檔、直連網址（mp4、mp3…）、YouTube 等 yt-dlp 支援的網址，或電腦系統音訊；拖檔案、按 🔗 輸入網址，或按 📻 切換系統音訊

## 需要

- herdr App（裝好並開過一次）、Node.js 18 以上
- `ffmpeg`、`ffplay`、`ffprobe` 在 PATH 上；播放 YouTube 等網站需要 `yt-dlp`

## 安裝

```bash
git clone https://github.com/ailazytech/herdr-tunr
node herdr-tunr/install.mjs
```

只會裝 `~/.config/herdr-app/mods/tunr/`，不改任何 layout；你的 `config.json` 不會被覆蓋。更新：`git pull` 後再跑一次。
安裝程式會檢查工具並提供安裝指令；互動終端可選擇立即安裝，`--yes` 會自動執行可自動安裝的指令。Linux 的 sudo 指令需手動執行。安裝後新終端才會讀到更新的 PATH；herdr 的新終端會自動更新，不用重開 App。

## 開啟

- 有裝 [herdr-quota](https://github.com/ailazytech/herdr-quota) 的話，底部狀態列有一顆 **tunr** 按鈕，點一下開、再點一下關
- 指令：`herdr-app do mod.open --name tunr`（再一次會關掉）
- 想要快捷鍵：在 `keys.json` 的 `global` 加 `"ctrl-alt-t": "mod.open:tunr"`

## 操作

視窗下方的控制列：播放／暫停、進度條（點哪裡跳到哪裡）、音量 −／+、開關畫面、黑白／低彩、S／M／L、✕ 關閉。
按 📻 切換至電腦系統音訊頻譜（進度條與音量會隱藏；Windows 上若偵測到目前系統媒體工作階段，會顯示「歌名 — 演出者」，播放／暫停會控制該媒體，並依媒體支援度顯示 ⏮／⏭ 上／下一首；無媒體工作階段時播放／暫停為凍結／恢復頻譜）。按 🔗 開啟網址輸入框；剪貼簿若有 HTTP(S) 網址，會自動填入並選取，按 Enter 就能播放，也可以修改或清掉。介面語言與 ranchr、herdr-quota 共用；可使用 `tunr.language-auto`、`tunr.language-zh` 或 `tunr.language-en` 切換。

指令（`herdr-app do tunr.<指令>`，或在 `keys.json` 綁 `tunr.<指令>`）：`toggle`（播放／暫停）、`prev`（上一首，系統音訊模式）、`next`（下一首，系統音訊模式）、`video`（開關畫面）、`mode`（黑白／低彩）、`size`（換尺寸）、`system`（切換系統音訊）、`close`。

## 設定

`~/.config/herdr-app/mods/tunr/config.json`，沒有也可以：

```json
{ "source": "system", "size": "S", "mode": "mono", "video": true, "volume": 80, "debug": false }
```

- `source`：開啟時播什麼；填 `"system"` 為系統音訊，沒設就等你把檔案拖進來
- `size`：`S`、`M`、`L`；`mode`：`mono`（黑白）、`low`（低彩度）；`video`：`false` 就是只聽聲音
- `debug`：`true` 時多一顆 FPS 按鈕，並每 2 秒把量到的數字寫到 `~/.config/herdr-app/data/tunr-stats.json`

在視窗裡調整音量、黑白／低彩度、尺寸、開關畫面，或是切換來源（拖入檔案、輸入網址、切換系統音訊），都會自動記在 `~/.config/herdr-app/data/tunr/settings.json`（不記錄播放位置秒數）；`config.json` 是手寫預設值（`install.mjs` 更新時也不會覆蓋），想回到預設值只要刪掉 `settings.json` 即可。

## 運作方式

- 畫面在背景引擎（`tunr.mjs`）裡算好：ffmpeg 把影像縮成字元格轉成 ASCII，ffplay 放聲音，再用本機 TCP（`127.0.0.1`）一幀一幀送給視窗；視窗只負責畫和控制
- 引擎開在一個叫 `tunr-engine` 的背景終端；關掉視窗就一起關，沒人連線 15 秒也會自己結束
- 聲音是主時鐘，畫面跟著聲音走，過期的幀直接丟掉，不會越播越慢
- 實測（Windows，每秒 24 幀，小視窗）：黑白每次重畫約 0.7 ms、不丟幀；低彩度每幀約 100 段文字、每秒約 23 幀

## 限制

- 系統音訊頻譜目前只支援 Windows（擷取 Windows 預設播放裝置的聲音），macOS 與 Linux 暫不支援
- 暫停、拉進度、改音量、換模式時會重開背景程序，有 0.2–0.5 秒的空檔
- 不支援 Spotify、Podcast 搜尋；網站是否能播放取決於 yt-dlp 與來源限制

## 移除

關掉視窗，刪掉 `~/.config/herdr-app/mods/tunr/`。

## 授權

[MIT](LICENSE)
