# YouTube Stream Discord Sync

Sync YouTube live stream playback with Discord messages.

## Paths

- `chrome-extension/`: Chrome extension for YouTube + Discord web
- `youtube-timestamp-server.user.js` + `discord-timestamp-sync.user.js`: standalone userscripts
- `YouTubeTimestampServer/`: Vencord plugin for Discord desktop with a local broker on `localhost`

## Install

### Chrome extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load the `chrome-extension/` folder as unpacked

### Userscripts

1. Install `youtube-timestamp-server.user.js`
2. Install `discord-timestamp-sync.user.js`
3. Enable both in your userscript manager

### Vencord plugin

1. Copy `YouTubeTimestampServer` to your Vencord `userplugins` folder
2. Build and inject Vencord
3. Restart Discord

## Use

1. Open a YouTube live stream
2. Open Discord in the channel with timestamped messages
3. Enable autoscroll from the web popup or the desktop channel menu

## Notes

- Web mode uses the Chrome extension or userscripts.
- `YT Sync` toggles Discord web autoscroll.
- Vencord mode keeps redirect timestamps from Discord messages.
