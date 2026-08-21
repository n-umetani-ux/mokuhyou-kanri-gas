/**
 * 稼働データ転記 v2.4 — 設定・定数定義
 *
 * 列インデックス・行範囲の根拠は README.md および
 * プロジェクト仕様書(2026-08時点)に基づく。数値がずれた場合は
 * まずここを疑うこと（稼働一覧側のレイアウト変更が最頻の原因）。
 */

var CONFIG = {
  SHEET_NAMES: {
    SETTINGS: '設定',
    RESULT_DB: '実績DB',
    STAFF_MASTER: '担当マスタ',
    LOG: '転記ログ',
    TARGET_DB: '目標DB',
    DASHBOARD: 'ダッシュボード'
  },

  SOURCE_SHEET_NAMES: {
    KOJIN_SUJI: '個人数字',
    TOKYO_TABLE: '稼働表（東京）'
  },

  // 個人数字シートの列インデックス（1始まり）
  KOJIN_COL: {
    NAME: 1,          // A: 氏名
    ITS_STAFF: 2,     // B: 社員its 人数
    ENG_STAFF: 3,     // C: 社員eng 人数
    BP_CASE: 6,       // F: BP（案件）
    BP_JINZAI: 7,     // G: BP（人財）
    WAIT_STAFF: 9,    // I: 待機社員 人数
    TOTAL_STAFF: 10,  // J: 総数（稼働人数）
    SALES_ENG: 16,    // P: 売上 社員eng
    SALES_TOTAL: 23,  // W: 売上合計
    PROFIT_ENG: 26,   // Z: 粗利 社員eng
    WAIT_PROFIT: 32,  // AF: 待機（粗利側）
    PROFIT_TOTAL: 34  // AH: 粗利合計
  },
  // 目標売上(X列)・目標粗利(AI列)は v2.1 で読み取り廃止（目標DBシートへ分離）
  KOJIN_LAST_COL: 34, // AH

  // 個人数字シートのブロック行範囲（1始まり、両端含む）
  BLOCKS: [
    { name: '東京', personRows: [3, 10], totalRow: 16 },
    { name: '大阪', personRows: [20, 23], totalRow: 26 },
    { name: '福岡', personRows: [30, 31], totalRow: 34 }
  ],

  // 東京のみ ENG セクション集計を別レコードとして作成する
  SECTION_BLOCKS: [
    { block: '東京', section: 'ENG' }
  ],

  // 稼働表（東京）「営業部待機一覧」の列インデックス（1始まり）
  WAIT_TABLE: {
    ANCHOR_TEXT: '営業部待機一覧',
    HEADER_OFFSET: 2,   // アンカー行からデータ開始行までのオフセット
    MAX_ROWS: 60,        // 安全のための走査上限
    CATEGORY_COL: 2,     // B: 区分（its / eng）
    SUB_COL: 3,           // C: （合計行判定にのみ使用）
    STAFF_COL: 4,         // D: 待機人数
    PROFIT_COL: 27        // AA: 調整後粗利（待機原価）
  },
  WAIT_CATEGORIES: ['its', 'eng'],
  WAIT_LOCATION: '東京',

  // 実績DB シートのヘッダ（目標売上・目標粗利は v2.1 で目標DBへ分離）
  RESULT_DB_HEADERS: [
    '年月', '区分', '拠点', 'セクション', '担当',
    '稼働人数', '売上', '粗利', '待機原価', '待機人数', 'BP数',
    '状態', '確定日', '転記元ファイル名', '転記日時'
  ],
  // upsert のキーとなる列（この5列の組み合わせで一意）
  RESULT_DB_KEY_COLS: ['年月', '区分', '拠点', 'セクション', '担当'],
  // v2.0 の実績DBから削除する列（マイグレーション対象）
  RESULT_DB_REMOVED_HEADERS: ['目標売上', '目標粗利'],

  // 在籍終了年月は 'YYYY-MM' 形式の文字列。空欄なら在籍中。
  // 対象年月 > 在籍終了年月 のときのみ転記対象から外す（文字列比較で判定可）。
  // セクションは v2.5 でダッシュボード集計用に追加した列（拠点の右隣）。手入力専用。
  STAFF_MASTER_HEADERS: ['氏名', '拠点', 'セクション', '個人数字の行', '在籍終了年月', '表示順'],
  // v2.0 の「在籍」列(TRUE/FALSE)からのマイグレーション時、FALSEだった行に
  // 自動で設定してよい在籍終了年月（対応表になければ空欄＋警告ログ）
  STAFF_MASTER_MIGRATION_END_YM: { '田邉': '2026-05' },
  // セクション列追加時（migrateStaffMasterAddSectionColumn）、東京の担当のうち
  // このリストに載っている氏名は 'ENG'、載っていない氏名は 'ITS' を初期値にする。
  // 大阪・福岡の担当は拠点にかかわらず空欄。
  STAFF_MASTER_SECTION_ENG_NAMES: ['衣笠'],
  STAFF_MASTER_INITIAL: [
    ['緒方', '東京', 'ITS', 3, '', 1],
    ['梅谷', '東京', 'ITS', 4, '', 2],
    ['工藤', '東京', 'ITS', 5, '', 3],
    ['小山', '東京', 'ITS', 6, '', 4],
    ['木村', '東京', 'ITS', 7, '', 5],
    ['平川', '東京', 'ITS', 8, '', 6],
    ['山田', '東京', 'ITS', 9, '', 7],
    ['衣笠', '東京', 'ENG', 10, '', 8],
    ['山口', '大阪', '', 20, '', 9],
    ['高山', '大阪', '', 21, '', 10],
    ['杉本', '大阪', '', 22, '', 11],
    ['田邉', '大阪', '', 23, '2026-05', 12],
    ['西川', '福岡', '', 30, '', 13],
    ['尾上', '福岡', '', 31, '', 14]
  ],

  // 目標DB：手入力専用（GASは読むだけで書き込まない）。実績DBとキーを揃える。
  TARGET_DB_HEADERS: [
    '年月', '区分', '拠点', 'セクション', '担当', '目標売上', '目標粗利', '目標稼働人数'
  ],
  TARGET_DB_NOTE: 'このシートは手入力専用です。GASからは書き込みません（読み取りも行いません）。',

  // 既存の転記ログシートに対しては、不足している列だけを末尾に追加するマイグレーションを行う
  // （migrateLogSheetHeaders）。そのため既存列の並び順はここで変更しない。新しい列は必ず末尾に足す。
  LOG_HEADERS: [
    '実行日時', '実行者', '対象月', '確定月', '暫定月', '処理件数', 'スキップ内容', '警告', 'エラー',
    '強制上書き', '月別内訳'
  ],

  FILE_NAME_PREFIX: 'エンジニア稼働一覧',
  FINALIZED_MARK: '確定',

  STATUS: {
    FINALIZED: '確定',
    PROVISIONAL: '暫定'
  },

  RECORD_KIND: {
    PERSON: '個人',
    LOCATION: '拠点',
    SECTION: 'セクション',
    WAITING: '待機'
  }
};

/**
 * 設定シートから key-value を1件取得する。A列=キー, B列=値の想定。
 */
function getSettingValue(ss, key) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.SETTINGS);
  if (!sheet) {
    throw new Error('「' + CONFIG.SHEET_NAMES.SETTINGS + '」シートが見つかりません。');
  }
  var values = sheet.getDataRange().getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) {
      return values[i][1];
    }
  }
  return null;
}

function getAdminEmails(ss) {
  var raw = getSettingValue(ss, 'adminEmails');
  if (!raw) return [];
  return String(raw).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

function getDriveFolderId(ss) {
  var id = getSettingValue(ss, 'driveFolderId');
  if (!id) {
    throw new Error('設定シートに driveFolderId が設定されていません。');
  }
  return id;
}

/**
 * 年月の値を 'YYYY-MM' 形式の文字列に正規化する。
 * 'YYYY-MM' のような文字列をセルに書き込むとスプレッドシートが日付として
 * 自動解釈してしまい、getValues() で読み戻すと Date オブジェクトになる。
 * 年月を扱う箇所（キーの組み立て・在籍終了年月の比較・対象月の判定・検証処理）は
 * すべてこの関数を通してから比較・キー生成を行うこと。生の値を直接比較しない。
 * @param {*} value セルの値（文字列 or Date）
 * @param {Spreadsheet} [ss] 指定があればそのスプレッドシートのタイムゾーンを使う
 */
function normalizeYearMonth(value, ss) {
  if (value === null || value === undefined || value === '') return '';

  if (Object.prototype.toString.call(value) === '[object Date]') {
    var timeZone = (ss && ss.getSpreadsheetTimeZone) ? ss.getSpreadsheetTimeZone() : 'Asia/Tokyo';
    return Utilities.formatDate(value, timeZone, 'yyyy-MM');
  }

  var str = String(value).trim();
  if (!str) return '';

  var m = str.match(/^(\d{4})[\/\-](\d{1,2})$/);
  if (m) {
    return m[1] + '-' + ('0' + m[2]).slice(-2);
  }
  return str;
}
