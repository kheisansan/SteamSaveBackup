# SteamSaveBackup

セーブデータ等を **サブディレクトリを含めて丸ごとコピー**する常駐アプリです。
Mac / Windows 両対応で、他のアプリを操作している最中でもグローバルショートカット一発でコピーできます。

扱う経路は3つです。

| 経路 | 役割 |
| --- | --- |
| **経路1** | 元データ（セーブデータ側）。バックアップ元／復元先 |
| **経路2** | バックアップ保存先。この直下に `yyyymmdd_hhMM` フォルダが積まれる |
| **復元元フォルダ** | 経路1へ書き戻す元。通常は経路2の中の `yyyymmdd_hhMM` フォルダを指定する |

## できること

| 仕様 | 実装 |
| --- | --- |
| Mac / Windows の実行可能アプリ | Electron + electron-builder（dmg / zip / NSIS / portable） |
| 経路を設定可能 | 環境設定の「経路設定」タブ（参照ダイアログ＋直接入力） |
| ネットワーク共有にも対応 | Windows は `\\server\share\folder`、macOS は `/Volumes/share/folder` |
| グローバルショートカット | 他アプリ操作中でも動作。トレイメニュー / メニューバーからも実行可 |
| 経路2へのコピー時に日時フォルダ | 経路2直下に `yyyymmdd_hhMM` を作成し、その中へコピー |
| ショートカットの変更 | 環境設定の「ショートカット」タブでキーを押して登録 |
| 起動時に実行するか選択 | 環境設定の「動作設定 > 起動」 |
| 窓を閉じてもバックグラウンド実行 | 閉じるとトレイに常駐（終了はトレイメニュー / Cmd+Q） |

### 既定のショートカット

| 操作 | macOS | Windows |
| --- | --- | --- |
| 経路1 → 経路2 にコピー（バックアップ） | `⌘ + ⌥ + ⇧ + A` | `Win + Alt + Shift + A` |
| 復元元 → 経路1 にコピー（復元） | `⌘ + ⌥ + ⇧ + Z` | `Win + Alt + Shift + Z` |

### コピーの挙動

- **経路1 → 経路2（バックアップ）**：実行時刻から `yyyymmdd_hhMM` フォルダを作り、経路1の中身をその中へコピーします。同じ分に2回実行した場合は `yyyymmdd_hhMM_2` になります。
- **復元元 → 経路1（復元）**：復元元フォルダの中身を経路1へそのまま展開します。
  - **日時フォルダは作りません。**
  - **常に強制上書きです。**「変更なしはスキップ」設定に関わらず全ファイルを書き戻し、経路1側が読み取り専用でも上書きします。
  - 復元元フォルダは「スナップショット」タブの一覧で「復元元にする」を押すとワンクリックで設定できます。
- サイズと更新日時が同じファイルは、バックアップでは既定でスキップします（大量ファイルでも2回目以降が高速）。
- 1ファイル失敗しても処理は止めず、最後にまとめてエラーを報告します。
- シンボリックリンクは辿らずリンクとして再作成するため、リンクのループでも安全です。
- コピー元とコピー先が入れ子になっている組み合わせは、事故防止のため実行前に拒否します。

## 開発

```bash
npm install          # 依存のインストール
npm start            # 開発起動
npm test             # コアロジックの単体テスト（74件）
npm run smoke        # Electron を起動してコピー実行まで通す統合テスト
```

> エディタ内蔵ターミナル（Cursor / VS Code）は `ELECTRON_RUN_AS_NODE=1` が設定されている場合があり、
> `electron` を直接叩くと素の Node として起動してしまいます。`npm start` などのスクリプトは
> `scripts/run-electron.js` 経由でこの環境変数を外してから起動します。

### ビルド

```bash
npm run build        # Mac + Windows を一括ビルド
npm run build:mac    # dmg + zip（arm64 / x64）
npm run build:win    # NSIS インストーラ + portable exe（x64）
```

成果物は `dist/` に出ます。

| ファイル | 対象 | 用途 |
| --- | --- | --- |
| `SteamSaveBackup-1.0.0-arm64.dmg` | macOS Apple Silicon | 通常のインストール（Applications へドラッグ） |
| `SteamSaveBackup-1.0.0.dmg` | macOS Intel | 同上 |
| `SteamSaveBackup-1.0.0-arm64-mac.zip` / `-mac.zip` | macOS | 展開してそのまま置くだけの配布用 |
| `SteamSaveBackup Setup 1.0.0.exe` | Windows x64 | NSIS インストーラ（インストール先変更可・ユーザー単位） |
| `SteamSaveBackup 1.0.0.exe` | Windows x64 | インストール不要のポータブル版 |

- macOS 版は arm64 / x64 の2種類が出ます。ビルドは Intel Mac 上でも Apple Silicon 上でも両方作れます。
- Windows 版は macOS 上でもそのままビルドできます（Wine 不要）。
- **署名していない未署名ビルドです。** 初回起動時に警告が出ます。
  - macOS：右クリック →「開く」、もしくは「システム設定 > プライバシーとセキュリティ」で許可
  - Windows：SmartScreen の「詳細情報」→「実行」
- 配布する場合は `dist/SHA256SUMS.txt` を一緒に添えると検証できます（`shasum -a 256 -c SHA256SUMS.txt`）。

### 構成

```
src/core/      Electron に依存しない処理（コピー・除外・設定・スナップショット管理）
src/main/      Electron メインプロセス（トレイ常駐・ショートカット・IPC・ログ）
src/preload/   contextBridge による最小 API 公開
src/renderer/  環境設定ウィンドウ（依存パッケージなしの素の HTML/CSS/JS）
test/          単体テスト + Electron 統合スモークテスト
scripts/       アイコン生成・Electron 起動ラッパー
```

設定は各OSの userData 配下に保存されます（環境設定の「動作設定」下部にパスを表示）。

- macOS: `~/Library/Application Support/SteamSaveBackup/settings.json`
- Windows: `%APPDATA%\SteamSaveBackup\settings.json`

## 注意点

- **macOS のアクセス権限**：`~/Library/Application Support` や外部ボリュームを読む場合、「システム設定 > プライバシーとセキュリティ」でフルディスクアクセスの許可が必要になることがあります。権限エラーはログに記録されます。
- **ネットワーク共有**：未マウント時はコピーが失敗し、通知とログで知らせます。同時コピー数（既定4）を小さくすると不安定な共有でも安定します。
- **ショートカットの登録失敗**：OSや他アプリが既に使っている組み合わせは登録できません。環境設定の「ショートカット」タブに理由が表示されるので別のキーに変更してください。
- **スナップショットの保持数**：0 は無制限です。1以上にすると、古い `yyyymmdd_hhMM` フォルダを自動削除します（命名規則に一致しないフォルダは削除しません）。
