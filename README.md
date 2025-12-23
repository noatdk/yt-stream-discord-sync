# YouTube Stream Discord Sync

Synchronize YouTube live stream playback with Discord messages by automatically scrolling to messages that match the current stream timestamp.

## Overview

This project consists of two components:

1. **YouTube Userscript** - Runs on YouTube and sends the current stream timestamp to a local server
2. **Vencord Plugin** - Receives timestamps from the server and automatically scrolls Discord to matching messages

## Prerequisites

- **Vencord** installed and configured for Discord
- **Tampermonkey** (or similar userscript manager) installed in your browser
- **Node.js** (for building the Vencord plugin)

## Installation

### Step 1: Install the Vencord Plugin

1. Copy the `YouTubeTimestampServer` folder to your Vencord userplugins directory:
   ```
   Vencord/src/userplugins/YouTubeTimestampServer/
   ```

2. Build Vencord:
   ```bash
   cd Vencord
   pnpm install
   pnpm build
   pnpm inject
   ```

3. Restart Discord

### Step 2: Install the YouTube Userscript

1. Open Tampermonkey (or your userscript manager)
2. Click "Create a new script"
3. Copy the entire contents of `youtube-timestamp-server.user.js` into the editor
4. Save the script (Ctrl+S or Cmd+S)

## Configuration

### Vencord Plugin Settings

1. Open Discord Settings
2. Go to **Vencord** → **Plugins**
3. Find **YouTubeTimestampServer** and configure:
   - **Enable automatic scrolling**: Toggle to enable/disable autoscrolling
   - **Check interval**: How often to check for new timestamps (default: 2 seconds)
   - **Server port**: Port for the local server (default: 8080)

### Userscript Configuration

The userscript uses port `8080` by default. If you need to change it:

1. Open the script in Tampermonkey
2. Find the line: `const PORT = 8080;`
3. Change to your desired port (must match the Vencord plugin port setting)
4. Save the script

## Usage

### Basic Usage

1. **Start watching a YouTube live stream** (or archived stream)
2. **Open Discord** in a channel where timestamp messages are being posted
3. **Enable autoscrolling** via the context menu:
   - Right-click on any channel
   - Select **"Enable Timestamp Autoscroll"** (checkbox will show current state)
4. The plugin will automatically scroll to messages that match the current stream timestamp

**Note**: Autoscrolling automatically turns off when you switch between channels or servers. You'll need to re-enable it in the new channel if desired.

### Setting Redirect Timestamps

You can manually set a redirect timestamp from any message:

1. Right-click on a message with a timestamp
2. Select **"Set as Redirect Timestamp"**
3. The YouTube stream will jump to that timestamp (if supported)
