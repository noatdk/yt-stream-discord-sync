# YouTube Stream Discord Sync

YouTubeライブの再生位置とDiscordメッセージを同期します。

## パス

- `chrome-extension/`: YouTube + Discord web 用のChrome拡張
- `youtube-timestamp-server.user.js` + `discord-timestamp-sync.user.js`: 単体のuserscript
- `YouTubeTimestampServer/`: Discordデスクトップ用のVencordプラグイン。`localhost` ブローカーあり

## インストール

### Chrome拡張

1. `chrome://extensions` を開く
2. デベロッパーモードを有効にする
3. `chrome-extension/` フォルダを「パッケージ化されていない拡張機能」として読み込む

### Userscript

1. `youtube-timestamp-server.user.js` を入れる
2. `discord-timestamp-sync.user.js` を入れる
3. userscriptマネージャーで有効にする

### Vencordプラグイン

1. `YouTubeTimestampServer` をVencordの `userplugins` にコピーする
2. Vencordをビルドして注入する
3. Discordを再起動する

## 使い方

1. YouTubeライブを開く
2. Discordでタイムスタンプ付きメッセージがあるチャンネルを開く
3. Webのポップアップかデスクトップのチャンネルメニューで自動スクロールを有効にする

## メモ

- WebはChrome拡張かuserscriptを使う。
- `YT Sync` の拡張ポップアップでDiscord webの動作を切り替えられる。
- VencordパスはDiscordメッセージからのリダイレクトジャンプに対応する。
