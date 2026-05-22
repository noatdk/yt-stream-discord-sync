# YouTube Stream Discord Sync

YouTubeライブの再生位置とDiscordメッセージを同期します。

## パス

- **Chrome拡張**: YouTube + Discord web。ローカルサーバーなし、Vencordなし
- **Vencordプラグイン**: YouTube + Discordデスクトップ。`localhost` ブローカーあり

## インストール

### Chrome拡張

1. `chrome://extensions` を開く
2. デベロッパーモードを有効にする
3. `chrome-extension/` フォルダを「パッケージ化されていない拡張機能」として読み込む

### Vencordプラグイン

1. `YouTubeTimestampServer` をVencordの `userplugins` にコピーする
2. Vencordをビルドして注入する
3. Discordを再起動する

## 使い方

1. YouTubeライブを開く
2. Discordでタイムスタンプ付きメッセージがあるチャンネルを開く
3. 自動スクロールを有効にする
   - Discord web: 右下の `YT Sync` ボタン
   - Discordデスクトップ: チャンネルのコンテキストメニュー

## メモ

- Chrome拡張はスタンドアロンです。
- `YT Sync` の拡張ポップアップでDiscord webの動作を切り替えられます。
- Vencordパスはメッセージからのリダイレクトジャンプをサポートします。
