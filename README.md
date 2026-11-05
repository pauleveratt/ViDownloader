# ViDownloader

One-click downloads for edits: YouTube (long-form + Shorts), TikTok, Instagram Reels, Twitch clips & VODs, and 1,000+ other sites. Trim to just the part you need, record live streams, or record any tab as a last resort. Every video comes out as **H.264/AAC MP4** so it drops straight into Premiere, Resolve or CapCut.

It has two parts:

- **Chrome extension** (`extension/`): the UI you click on a video page.
- **Helper** (`helper/`): a small Node.js program on this PC that runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg. It listens on `127.0.0.1` only and needs a secret token, so websites can't talk to it.

## Install

1. Run the installer (right-click → *Run with PowerShell*, or from a terminal):
   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
   It downloads yt-dlp into `bin\`, checks for Node.js + ffmpeg, starts the helper, adds it to Windows startup, and **copies an access token to your clipboard**.
2. In Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the `extension` folder.
3. Pin the ViDownloader icon, click it, and paste the token.

Re-running `install.ps1` is safe: it updates yt-dlp, restarts the helper and keeps your token.

## Using it

Open a video and click the icon.

| What | How |
|---|---|
| Whole video | **Download MP4**. Default is 1080p, which YouTube serves as H.264 natively. *Best available* may be 4K VP9/AV1, which gets converted to H.264 and takes a while. |
| Just a clip | Fill in **Start/End** (`1:23`, `1:02:03`). Pause the video at a spot and press the ⏱ button to grab the current time. Twitch VODs download only that section; YouTube/TikTok/IG download fully and are then cut frame-accurately. |
| Audio | **MP3** or **WAV**. |
| Private / login-only posts | Tick **Use my Chrome login for this site**. Your cookies for that site are passed to yt-dlp for that one job and then deleted. It's on by default everywhere except YouTube, and your choice is remembered per site. On Twitch it's what makes recordings ad-free when you're subscribed or have Turbo. |
| Instagram stories | Open the story and let it play a second, then click the icon. ViDownloader saves the story file your browser already loaded (best quality, audio merged), instead of asking Instagram's API, which often refuses yt-dlp. Photo stories: use **Images on this page**. If yt-dlp can't read another Instagram post, the same browser copy is offered automatically. |
| Live stream (YouTube, Twitch, TikTok) | The popup switches to **Record live stream**. *From now* records until you press Stop or the auto-stop timer fires. *From start of stream* (YouTube/Twitch) also grabs what already aired. |
| Images (Instagram photo posts, carousels, photo reels, any page) | **Images on this page** shows the page's real images at the largest size it offers. On-screen post images are preselected; thumbnails that link elsewhere are listed but not selected. Saved to `<Platform>\Images`; WebP/AVIF become PNG. For carousels, swipe through the slides first so they're loaded. |
| Still frame | Pause where you want and click **Save frame**. Supported sites give a full-resolution PNG from the source (e.g. 4K on YouTube) with no player UI; other pages are captured from the player. |
| Trim / cut segments after saving | Click **Edit** on a finished download (in the popup, Recent downloads or History). Play to a moment and press **I** (start), then **O** (end) to add a segment; repeat for more. Drag a segment's edges on the timeline or type exact times; **←/→** steps one frame (**Shift** = 1 s). Export as **one joined file** or **separate clips**. Cuts are frame-accurate, saved next to the original (which is never changed), and logged in History with the original's source link. |
| Unsupported site | **Detected media on this page** lists video files/streams the page loaded (press play first). The toolbar badge shows how many were found. |
| Anything else (e.g. Instagram Live) | **Record this tab** captures the tab's picture and sound in real time. You keep hearing it, and you can switch to other tabs. Make the video fill the tab first for best quality. DRM-protected players (Netflix etc.) record black. |

Files go to `Videos\ViDownloader\<Platform>\<uploader> - <title> [id].mp4` (folder changeable in Settings). The **History** page (clock icon) lists everything with *Copy credit* (e.g. `@creator on TikTok — https://…`), *Show file* and CSV export.

**Toolbar icon:** a red dot and red **REC** badge while anything is recording; a blue badge with progress (e.g. `45%`) while downloading or converting; otherwise the number of detected media files on the current page. Hover the icon for details.

**Closing tabs or Chrome mid-job:** downloads and live-stream recordings run in the helper, so they keep going and save normally even if you close the tab or Chrome. *Record this tab* stops when its tab closes and saves what it captured (if Chrome closes entirely, the helper saves it about a minute later). Temporary files are removed when each job ends, and anything left by a crash or shutdown (including temporary cookie files) is cleaned up the next time the helper starts.

## Troubleshooting

- **"Helper isn't running"**: double-click `start-helper.vbs`. Logs are in `helper\logs\helper.log`.
- **A site suddenly fails**: Settings → *Update now* (yt-dlp is also updated weekly).
- **Instagram says login required / rate-limit**: make sure you're logged in to Instagram in Chrome and *Use my Chrome login* is ticked.
- **Remove from startup**: `install.ps1 -NoStartup`, or delete *ViDownloader Helper* from `shell:startup`.

Use it responsibly: respect each platform's terms and copyright/fair use for the material you include in client work.
