# mokuhyou-kanri-gas

目標管理・稼働データ転記用の Google Apps Script プロジェクト。

## 概要

このスプレッドシートに紐づく（コンテナバインド）GASで、以下を行う。

- 「稼働表（東京）」「個人数字」シートなどのソースデータを、月次で「実績DB」「目標DB」に転記
- 転記結果を「転記ログ」シートに記録
- 「ダッシュボード」シートの再構築
- 管理者（設定シートに登録されたメールアドレス）のみがカスタムメニュー「稼働データ転記」から操作可能

## 主なファイル

| ファイル | 役割 |
|---|---|
| `Config.js` | シート名・列インデックス・設定値取得などの定数・設定 |
| `Main.js` | 転記処理のメインロジック |
| `Source.js` | ソースファイル（稼働表）の検索・取得 |
| `Store.js` | 実績DB・目標DBへの書き込み |
| `Dashboard.js` | ダッシュボード再構築 |
| `diagnostics_dashboard.js` | ダッシュボードの診断用処理 |
| `Menu.js` | カスタムメニュー・管理者判定 |
| `テスト.js` | 動作確認用スクリプト |
| `appsscript.json` | GASプロジェクトのマニフェスト |

## 関連情報（要追記）

- 紐づくスプレッドシート名: `（未確認・要追記）`
- Google Drive フォルダID（`driveFolderId`、稼働表の格納先）: 設定シートで管理（値は環境依存のため本READMEには記載しない）
- スクリプトID: `.clasp.json` 参照

## clasp 連携

```
clasp login    # 初回のみ。Apps Script APIの有効化が必要
clasp pull     # GAS側の最新コードを取得
clasp push     # ローカルの変更をGASへ反映
```

`.clasprc.json`（OAuthトークン）はコミットしないこと（`.gitignore` で除外済み）。
