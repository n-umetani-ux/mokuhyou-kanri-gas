/**
 * 実績DB・担当マスタ・転記ログへの書き込みを担当する。
 * 書き込み先はこの3シートのみ（稼働一覧ファイルへは一切書き込まない）。
 * 目標DB はこのホワイトリストに含めない。GASからは ensureTargetDbSheet() による
 * 初回のシート作成（ヘッダ行のみ）を除き、一切書き込まない（読み取りも行わない）。
 */

function ensureSheetWithHeaders(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

/**
 * 指定した列全体をテキスト書式（@）にする。年月・在籍終了年月・確定日など、
 * スプレッドシートに日付として自動解釈されると困る列に、値を書き込む前に適用する。
 * 既存セルの書式を変えるだけでは既に日付化された値は戻らない点に注意
 * （値そのものの読み取り側の補正は normalizeYearMonth を使う）。
 */
function applyTextFormatToColumns(sheet, headers, columnNames) {
  columnNames.forEach(function (name) {
    var idx = headers.indexOf(name);
    if (idx === -1) return;
    sheet.getRange(1, idx + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

function ensureResultDbSheet(ss) {
  var sheet = ensureSheetWithHeaders(ss, CONFIG.SHEET_NAMES.RESULT_DB, CONFIG.RESULT_DB_HEADERS);
  applyTextFormatToColumns(sheet, CONFIG.RESULT_DB_HEADERS, ['年月', '確定日']);
  return sheet;
}

function ensureLogSheet(ss) {
  var sheet = ensureSheetWithHeaders(ss, CONFIG.SHEET_NAMES.LOG, CONFIG.LOG_HEADERS);
  migrateLogSheetHeaders(sheet);
  return sheet;
}

/**
 * 既存の転記ログシートに CONFIG.LOG_HEADERS の列が不足していれば末尾に追加する。
 * 既存列の並び順は変更しない（appendLog は CONFIG.LOG_HEADERS の順で1行を組み立てるため、
 * 既存列の位置がずれると過去行との整合が崩れる）。
 */
function migrateLogSheetHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var missing = CONFIG.LOG_HEADERS.filter(function (h) { return headerRow.indexOf(h) === -1; });
  if (missing.length === 0) return;
  sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
}

function ensureStaffMasterSheet(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STAFF_MASTER);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAMES.STAFF_MASTER);
    applyTextFormatToColumns(sheet, CONFIG.STAFF_MASTER_HEADERS, ['在籍終了年月']);
    sheet.getRange(1, 1, 1, CONFIG.STAFF_MASTER_HEADERS.length).setValues([CONFIG.STAFF_MASTER_HEADERS]);
    sheet.getRange(2, 1, CONFIG.STAFF_MASTER_INITIAL.length, CONFIG.STAFF_MASTER_HEADERS.length)
      .setValues(CONFIG.STAFF_MASTER_INITIAL);
  } else {
    applyTextFormatToColumns(sheet, CONFIG.STAFF_MASTER_HEADERS, ['在籍終了年月']);
  }
  return sheet;
}

/**
 * v2.0 の担当マスタ D列「在籍」(TRUE/FALSE) を v2.1 の「在籍終了年月」に変換する。
 * 既に移行済み（ヘッダが「在籍終了年月」）の場合は何もしない。
 * 旧値FALSEの行は STAFF_MASTER_MIGRATION_END_YM の対応表があればその値を設定し、
 * なければ空欄にした上で手入力を促す警告を返す。
 * @return {Array<string>} 警告メッセージ
 */
function migrateStaffMasterActiveColumn(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STAFF_MASTER);
  if (!sheet || sheet.getLastColumn() < 4) return [];

  var header = String(sheet.getRange(1, 4).getValue()).trim();
  if (header !== '在籍') return [];

  sheet.getRange(1, 4).setValue('在籍終了年月');

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var warnings = [];
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  var updated = values.map(function (row) {
    var name = String(row[0]).trim();
    var wasActive = row[3] === true || String(row[3]).toUpperCase() === 'TRUE';
    if (wasActive) return [''];

    var mappedEndYm = CONFIG.STAFF_MASTER_MIGRATION_END_YM[name];
    if (mappedEndYm) return [mappedEndYm];

    warnings.push(
      '担当マスタ「' + name + '」：旧「在籍」列がFALSEでしたが対応表にないため在籍終了年月を空欄にしました。手で入力してください。'
    );
    return [''];
  });
  sheet.getRange(2, 4, updated.length, 1).setValues(updated);
  return warnings;
}

/**
 * v2.5：担当マスタに「セクション」列（拠点の右隣）を追加する（1回限りのマイグレーション）。
 * 既に列が存在する場合は何もしない。初期値は東京の担当のうち
 * CONFIG.STAFF_MASTER_SECTION_ENG_NAMES に載っている氏名が 'ENG'、それ以外の東京の担当は
 * 'ITS'、大阪・福岡の担当は空欄。以降はこの列を手入力で運用する。
 */
function migrateStaffMasterAddSectionColumn(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STAFF_MASTER);
  if (!sheet) return;

  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
    : [];
  if (headerRow.indexOf('セクション') !== -1) return;

  sheet.insertColumnAfter(2);
  sheet.getRange(1, 3).setValue('セクション');

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var locations = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var engNames = CONFIG.STAFF_MASTER_SECTION_ENG_NAMES;

  var sections = names.map(function (nameRow, i) {
    var name = String(nameRow[0]).trim();
    var location = String(locations[i][0]).trim();
    if (!name) return [''];
    if (location !== '東京') return [''];
    return [engNames.indexOf(name) !== -1 ? 'ENG' : 'ITS'];
  });
  sheet.getRange(2, 3, sections.length, 1).setValues(sections);
}

/**
 * 担当マスタを読み取る。列位置はハードコードせずヘッダ名で解決する
 * （migrateStaffMasterAddSectionColumn 未実行でセクション列がまだ無い担当マスタでも
 * 正しく読めるようにするため）。セクション列が無い場合は section: '' を返す。
 * @return {Array<{name:string, location:string, section:string, kojinRow:number, endYm:string, order:number}>}
 * endYm は 'YYYY-MM' 形式。空文字なら在籍中。
 */
function getStaffMaster(ss) {
  var sheet = ensureStaffMasterSheet(ss);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];

  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var nameIdx = headerRow.indexOf('氏名');
  var locationIdx = headerRow.indexOf('拠点');
  var sectionIdx = headerRow.indexOf('セクション');
  var kojinRowIdx = headerRow.indexOf('個人数字の行');
  var endYmIdx = headerRow.indexOf('在籍終了年月');
  var orderIdx = headerRow.indexOf('表示順');

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values
    .filter(function (row) { return row[nameIdx]; })
    .map(function (row) {
      return {
        name: String(row[nameIdx]).trim(),
        location: String(row[locationIdx]).trim(),
        section: sectionIdx === -1 ? '' : String(row[sectionIdx]).trim(),
        kojinRow: Number(row[kojinRowIdx]),
        endYm: normalizeYearMonth(row[endYmIdx], ss),
        order: Number(row[orderIdx]) || 0
      };
    });
}

/**
 * 対象年月時点で在籍しているか（在籍終了年月が空欄、または対象年月 <= 在籍終了年月）。
 * 'YYYY-MM' は辞書順と時系列順が一致するため文字列比較でよい。
 */
function isStaffActiveForYm(person, ym) {
  var endYm = normalizeYearMonth(person.endYm);
  var normalizedYm = normalizeYearMonth(ym);
  return !endYm || normalizedYm <= endYm;
}

/**
 * 対象年月について転記対象となる担当者のリストを返す。
 * runTranscribe が実際に使う判定と同一のロジック（isStaffActiveForYm）を呼ぶ。
 */
function getActiveStaffForYm(staffMaster, ym) {
  return staffMaster.filter(function (p) { return isStaffActiveForYm(p, ym); });
}

function buildResultDbKey(record, ss) {
  return CONFIG.RESULT_DB_KEY_COLS.map(function (col) {
    var value = record[col];
    return col === '年月' ? normalizeYearMonth(value, ss) : value;
  }).join('');
}

/**
 * 実績DBへ upsert する。キーは 年月+区分+拠点+セクション+担当。
 * 範囲一括の getValues/setValues のみを使用し、セル単位のループは行わない。
 */
function upsertResultDb(ss, records) {
  if (!records || records.length === 0) return { updated: 0, inserted: 0 };

  var sheet = ensureResultDbSheet(ss);
  var headers = CONFIG.RESULT_DB_HEADERS;
  var ymCol = headers.indexOf('年月');
  var lastRow = sheet.getLastRow();
  var existingRows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

  // スプレッドシート側で日付として自動解釈された年月を書き戻し時に自己修復する。
  existingRows.forEach(function (row) {
    row[ymCol] = normalizeYearMonth(row[ymCol], ss);
  });

  var keyIndex = {};
  existingRows.forEach(function (row, i) {
    var record = {};
    headers.forEach(function (h, c) { record[h] = row[c]; });
    keyIndex[buildResultDbKey(record, ss)] = i;
  });

  var updated = 0;
  var inserted = 0;

  records.forEach(function (record) {
    var rowArray = headers.map(function (h) {
      return record[h] === undefined ? '' : record[h];
    });
    var key = buildResultDbKey(record, ss);
    if (Object.prototype.hasOwnProperty.call(keyIndex, key)) {
      existingRows[keyIndex[key]] = rowArray;
      updated++;
    } else {
      existingRows.push(rowArray);
      keyIndex[key] = existingRows.length - 1;
      inserted++;
    }
  });

  writeResultDbRows(sheet, existingRows);
  return { updated: updated, inserted: inserted };
}

/**
 * 在籍終了年月を過ぎた月の個人レコードのみを実績DBから削除する。
 * 在籍終了年月以前（当月含む）の行は削除しない。
 */
function removeRecordsPastEndDate(ss, staffMaster) {
  var endYmByName = {};
  staffMaster.forEach(function (p) {
    if (p.endYm) endYmByName[p.name] = p.endYm;
  });
  if (Object.keys(endYmByName).length === 0) return 0;

  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet) return 0;

  var headers = CONFIG.RESULT_DB_HEADERS;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var kindIdx = headers.indexOf('区分');
  var personIdx = headers.indexOf('担当');
  var ymIdx = headers.indexOf('年月');

  var before = rows.length;
  var remaining = rows.filter(function (row) {
    if (row[kindIdx] !== CONFIG.RECORD_KIND.PERSON) return true;
    var endYm = endYmByName[row[personIdx]];
    if (!endYm) return true;
    return normalizeYearMonth(row[ymIdx], ss) <= endYm;
  });

  if (remaining.length !== before) {
    writeResultDbRows(sheet, remaining);
  }
  return before - remaining.length;
}

/**
 * v2.0 の実績DBに残る「目標売上」「目標粗利」列を削除する（1回限りのマイグレーション）。
 * 既に削除済み、またはシート未作成の場合は何もしない。
 */
function migrateResultDbRemoveTargetColumns(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet) return;
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;

  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  var colsToDelete = CONFIG.RESULT_DB_REMOVED_HEADERS
    .map(function (name) { return headerRow.indexOf(name); })
    .filter(function (idx) { return idx !== -1; })
    .sort(function (a, b) { return b - a; }); // 右から削除してインデックスのズレを防ぐ

  colsToDelete.forEach(function (idx) {
    sheet.deleteColumn(idx + 1);
  });
}

/**
 * 目標DBシートを作成する（手入力専用）。存在しない場合のみヘッダ行を作成し、
 * それ以外では一切書き込まない。1行目に注記、2行目からヘッダ。
 */
function ensureTargetDbSheet(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.TARGET_DB);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAMES.TARGET_DB);
    applyTextFormatToColumns(sheet, CONFIG.TARGET_DB_HEADERS, ['年月']);
    sheet.getRange(1, 1).setValue(CONFIG.TARGET_DB_NOTE);
    sheet.getRange(2, 1, 1, CONFIG.TARGET_DB_HEADERS.length).setValues([CONFIG.TARGET_DB_HEADERS]);
  } else {
    applyTextFormatToColumns(sheet, CONFIG.TARGET_DB_HEADERS, ['年月']);
  }
  return sheet;
}

/**
 * ダッシュボードシートを作成する（存在しない場合のみ挿入）。
 * このシートに対する書き込みは ensureDashboardSheet / writeDashboardSheet のみで行う。
 */
function ensureDashboardSheet(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.DASHBOARD);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAMES.DASHBOARD);
  }
  return sheet;
}

/**
 * ダッシュボードシートの内容を全消去してから、plan の内容で書き直す（追記はしない）。
 * plan は Dashboard.gs 側で組み立てた表示計画（値・数式・書式・非表示行・セルメモ）。
 * 実績DB・目標DB・担当マスタへは一切書き込まない（このシートのみが対象）。
 * @param {Object} plan {
 *   numRows, numCols,
 *   values: string[][]（'='始まりは数式として入る）,
 *   numberFormats: (string|null)[][],
 *   notes: string[][]（values と同じ大きさ。空文字でメモなし）,
 *   hiddenRows: number[]（1始まりの行番号）,
 *   frozenRows: number, frozenColumns: number
 * }
 */
function writeDashboardSheet(ss, plan) {
  var sheet = ensureDashboardSheet(ss);

  var maxRows = sheet.getMaxRows();
  var maxCols = sheet.getMaxColumns();
  sheet.showRows(1, maxRows);
  if (maxCols > 0) sheet.showColumns(1, maxCols);
  sheet.getRange(1, 1, maxRows, maxCols).clearContent().clearFormat();

  if (plan.numRows > maxRows) sheet.insertRowsAfter(maxRows, plan.numRows - maxRows);
  if (plan.numCols > maxCols) sheet.insertColumnsAfter(maxCols, plan.numCols - maxCols);

  var range = sheet.getRange(1, 1, plan.numRows, plan.numCols);
  range.setValues(plan.values);
  if (plan.numberFormats) range.setNumberFormats(plan.numberFormats);
  if (plan.notes) range.setNotes(plan.notes);

  (plan.hiddenRows || []).forEach(function (r) {
    sheet.hideRows(r);
  });

  sheet.setFrozenRows(plan.frozenRows || 0);
  sheet.setFrozenColumns(plan.frozenColumns || 0);
}

/**
 * 年月 -> 状態 のマップを返す（同一年月内の状態は同じ値である前提）。
 */
function getMonthStatusMap(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  var map = {};
  if (!sheet) return map;
  var headers = CONFIG.RESULT_DB_HEADERS;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;

  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var yearMonthIdx = headers.indexOf('年月');
  var statusIdx = headers.indexOf('状態');
  rows.forEach(function (row) {
    var ym = normalizeYearMonth(row[yearMonthIdx], ss);
    if (ym && !map[ym]) {
      map[ym] = row[statusIdx];
    }
  });
  return map;
}

/**
 * 実績DBをキー（年月＋区分＋拠点＋セクション＋担当）でグルーピングし、
 * 重複しているキーとその行群・超過行数を返す。年月は正規化してからキーを組み立てる。
 * @return {{groups: Object<string, Array>, duplicateKeys: Array<string>, excessRowCount: number}}
 */
function findResultDbDuplicateGroups(ss) {
  var result = { groups: {}, duplicateKeys: [], excessRowCount: 0 };
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet || sheet.getLastRow() < 2) return result;

  var headers = CONFIG.RESULT_DB_HEADERS;
  var ymCol = headers.indexOf('年月');
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();

  rows.forEach(function (row) {
    row[ymCol] = normalizeYearMonth(row[ymCol], ss);
    var record = {};
    headers.forEach(function (h, c) { record[h] = row[c]; });
    var key = buildResultDbKey(record, ss);
    if (!result.groups[key]) result.groups[key] = [];
    result.groups[key].push(row);
  });

  Object.keys(result.groups).forEach(function (key) {
    var count = result.groups[key].length;
    if (count > 1) {
      result.duplicateKeys.push(key);
      result.excessRowCount += count - 1;
    }
  });

  return result;
}

function writeResultDbRows(sheet, rows) {
  var headers = CONFIG.RESULT_DB_HEADERS;
  var currentDataRows = sheet.getLastRow() - 1;
  if (currentDataRows > 0) {
    sheet.getRange(2, 1, currentDataRows, headers.length).clearContent();
  }
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

function appendLog(ss, logRecord) {
  var sheet = ensureLogSheet(ss);
  var row = CONFIG.LOG_HEADERS.map(function (h) {
    return logRecord[h] === undefined ? '' : logRecord[h];
  });
  sheet.appendRow(row);
}
