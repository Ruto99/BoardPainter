# BoardPainter

無料のデジタルスカルプト（3D造形）**デスクトップアプリ**です。Windows / macOS / Linux で動作し、インストール後はネット接続なしで使えます。

## ダウンロード / インストール（Windows）

GitHub の **Actions → Build desktop app** の最新の実行結果から `BoardPainter-Windows` をダウンロードしてください。中に2種類の実行ファイルが入っています。

| ファイル | 内容 |
| --- | --- |
| `BoardPainter-Setup-x.y.z.exe` | インストーラー（スタートメニュー・デスクトップにショートカット作成） |
| `BoardPainter-x.y.z-portable.exe` | インストール不要。ダブルクリックでそのまま起動 |

> 署名していないため、初回起動時に Windows SmartScreen が「WindowsによってPCが保護されました」と表示することがあります。「詳細情報」→「実行」で起動できます。

`.obj` / `.stl` ファイルを `BoardPainter.exe` にドラッグ＆ドロップする、または「プログラムから開く」で選ぶと、そのファイルを読み込んで起動します。

## 機能

- **ブラシ（1〜9キー）**: スタンダード / クレイ / 膨らませる / スムーズ / 平らにする / つまむ / 溝 / ムーブ / マスク
- **修飾キー**: `Shift` スムーズ、`Ctrl` マスク、`Alt` 反転、`[` `]` ブラシサイズ
- **表示**: 左右対称（`X`）、ワイヤーフレーム（`W`）、全体表示（`F`）、全画面（`F11`）、ペンタブレット筆圧対応
- **ワンクリック処理**: 細分化（`Ctrl+D`）、全体スムーズ、左右対称化、中央に配置、マスク反転／解除
- **書き出し**: OBJ / GLB（ゲーム用）/ STL（3Dプリント用・Z軸上向き・底面Z=0・高さmm指定）。保存先はダイアログで選択
- **読み込み**: OBJ / STL（`Ctrl+O`・ドラッグ＆ドロップ・起動時の引数）
- 作業内容は自動保存され、次回起動時に復元

## 操作

| 操作 | 内容 |
| --- | --- |
| モデル上を左ドラッグ | 造形 |
| 背景を左ドラッグ | 回転 |
| 右ドラッグ | 平行移動 |
| ホイール | ズーム |
| `Ctrl+Z` / `Ctrl+Y` | 元に戻す / やり直し |
| `Ctrl+O` | モデルを読み込み |
| `F11` | 全画面 |

## 開発・自分でビルドする

Node.js 20 以上が必要です。

```bash
npm install          # 依存関係のインストール（three.js を src/vendor にコピー）
npm start            # 開発用に起動
npm run dist:win     # Windows 用 exe（インストーラー + ポータブル）を dist/ に作成
npm run dist:mac     # macOS 用 dmg
npm run dist:linux   # Linux 用 AppImage
```

Windows のインストーラーは Windows 上でビルドしてください（Linux/macOS から作る場合は wine が必要）。`main` ブランチや `v*` タグへの push で GitHub Actions が3つのOS向けに自動ビルドします。

### 構成

| パス | 役割 |
| --- | --- |
| `electron/main.js` | アプリ本体（ウィンドウ・ファイルダイアログ・`app://` でUIを配信） |
| `electron/preload.js` | 画面側に公開するネイティブAPI（`window.bp`） |
| `src/index.html` | 造形エンジンとUI |
| `scripts/vendor.js` | three.js などをオフライン用に `src/vendor/` へコピー |

## 使用ライブラリ

- [Electron](https://www.electronjs.org/) 38
- [three.js](https://threejs.org/) 0.160.0
- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) 0.7.3
