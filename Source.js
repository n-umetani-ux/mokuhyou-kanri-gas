/**
 * 稼働一覧ファイルの検索・読み取りを担当する。
 * 稼働一覧ファイルへの書き込み・リネームは行わない（読み取り専用）。
 */

/**
 * 全角の数字・記号を半角に正規化する。
 * ファイル名の前方一致検索や確定日抽出のために使用する。
 */
function normalizeZenkaku(str) {
  if (str == null) return '';
  return String(str)
    .replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    })
    .replace(/／/g, '/')
    .replace(/（/g, '(')
    .replace(/）/g, ')');
}

/**
 * 指定フォルダから対象年月の稼働一覧ファイルを前方一致で検索する。
 * ゼロ埋りなし表記との互換のため、両方の候補で検索してマージする。
 * 確定版・暫定版が両方ヒットした場合は確定版を優先する。
 *
 * @return {File|null} 見つかったDriveのFileオブジェクト。見つからなければnull。
 */
function findKakudoFile(driveFolderId, year, month) {
  var folder = DriveApp.getFolderById(driveFolderId);
  var monthPadded = ('0' + month).slice(-2);
  var candidates = [
    CONFIG.FILE_NAME_PREFIX + year + '年' + monthPadded + '月度',
    CONFIG.FILE_NAME_PREFIX + year + '年' + month + '月度'
  ];

  var seenIds = {};
  var matches = [];
  candidates.forEach(function (prefix) {
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var name = normalizeZenkaku(f.getName());
      if (name.indexOf(normalizeZenkaku(prefix)) === 0 && !seenIds[f.getId()]) {
        seenIds[f.getId()] = true;
        matches.push(f);
      }
    }
  });

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  var finalized = matches.filter(function (f) {
    return f.getName().indexOf(CONFIG.FINALIZED_MARK) !== -1;
  });
  return finalized.length > 0 ? finalized[0] : matches[0];
}

/**
 * ファイル名から締め状態(確定/暫定)と確定日を判定する。
 * 判定はファイル名に「確定」を含むかどうかの単純な部分一致のみで行う。
 */
function parseFileStatus(fileName) {
  var isFinalized = fileName.indexOf(CONFIG.FINALIZED_MARK) !== -1;
  var status = isFinalized ? CONFIG.STATUS.FINALIZED : CONFIG.STATUS.PROVISIONAL;

  var finalizedDate = '';
  var normalized = normalizeZenkaku(fileName);
  var m = normalized.match(/(\d{1,2})\/(\d{1,2})確定/);
  if (m) {
    finalizedDate = m[1] + '/' + m[2];
  }
  return { status: status, finalizedDate: finalizedDate };
}

/**
 * 個人数字シートの全データ範囲を取得する（未加工の値のまま）。
 * 戻り値は 0 始まり配列。行 r・列 c のセル値は data[r-1][c-1] で取得する。
 */
function readKojinSujiGrid(ss) {
  var sheet = ss.getSheetByName(CONFIG.SOURCE_SHEET_NAMES.KOJIN_SUJI);
  if (!sheet) return null;
  var lastRow = Math.max.apply(null, CONFIG.BLOCKS.map(function (b) { return b.totalRow; }));
  return sheet.getRange(1, 1, lastRow, CONFIG.KOJIN_LAST_COL).getValues();
}

function cellValue(grid, row, col) {
  var v = grid[row - 1][col - 1];
  return (v === '' || v === null || v === undefined) ? 0 : v;
}

/**
 * 稼働表（東京）「営業部待機一覧」から its / eng の人数・待機原価を集計する。
 */
function readWaitBreakdown(ss) {
  var sheet = ss.getSheetByName(CONFIG.SOURCE_SHEET_NAMES.TOKYO_TABLE);
  if (!sheet) return null;

  var colA = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  var anchorRow = -1;
  for (var i = 0; i < colA.length; i++) {
    if (String(colA[i][0]).indexOf(CONFIG.WAIT_TABLE.ANCHOR_TEXT) !== -1) {
      anchorRow = i + 1;
      break;
    }
  }
  if (anchorRow === -1) return null;

  var dataStart = anchorRow + CONFIG.WAIT_TABLE.HEADER_OFFSET;
  var lastCol = CONFIG.WAIT_TABLE.PROFIT_COL;
  var maxRow = Math.min(dataStart + CONFIG.WAIT_TABLE.MAX_ROWS - 1, sheet.getLastRow());
  if (maxRow < dataStart) return null;

  var rows = sheet.getRange(dataStart, 1, maxRow - dataStart + 1, lastCol).getValues();

  var result = {};
  CONFIG.WAIT_CATEGORIES.forEach(function (cat) {
    result[cat] = { count: 0, cost: 0 };
  });

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var category = String(row[CONFIG.WAIT_TABLE.CATEGORY_COL - 1] || '').trim();
    var sub = String(row[CONFIG.WAIT_TABLE.SUB_COL - 1] || '').trim();
    var staff = row[CONFIG.WAIT_TABLE.STAFF_COL - 1];
    var profit = row[CONFIG.WAIT_TABLE.PROFIT_COL - 1];

    if (!category && !sub && staff !== '' && staff !== null && staff !== undefined) {
      break; // 合計行に到達
    }
    var catLower = category.toLowerCase();
    if (CONFIG.WAIT_CATEGORIES.indexOf(catLower) !== -1) {
      result[catLower].count += (staff || 0);
      result[catLower].cost += (profit || 0);
    }
  }

  return result;
}
