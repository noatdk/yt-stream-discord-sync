# YouTube Stream Discord Sync

Sync YouTube live stream playback with Discord messages.

## Paths

- **Chrome extension**: YouTube + Discord web, no local server, no Vencord
- **Vencord plugin**: YouTube + Discord desktop, local broker on `localhost`

## Install

### Chrome extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Load the `chrome-extension/` folder as unpacked

### Vencord plugin

1. Copy `YouTubeTimestampServer` to your Vencord `userplugins` folder
2. Build and inject Vencord
3. Restart Discord

## Use

1. Open a YouTube live stream
2. Open Discord in the channel with timestamped messages
3. Enable autoscroll
   - Discord web: click the `YT Sync` button
   - Discord desktop: use the channel context menu

## Notes

- The Chrome extension is standalone.
- Use the `YT Sync` extension popup to toggle Discord web behavior.
- The Vencord path still supports redirect timestamps from Discord messages.
