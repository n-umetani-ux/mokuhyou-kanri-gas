/**
 * 実績DB → 目標管理シートへの書き戻し（新システムへの完全移行までの併用期間用）。
 * 実績DBが正。目標管理シートは表示用の器として上書きする。
 * 書き込み先は「目標管理（2026年4月～3月末)」シートのみ。
 * 実績DB・担当マスタ・転記ログ・目標DB へは一切書き込まない（読み取りのみ）。
 */

var KANRI_SHEET_NAME = '目標管理（2026年4月～3月末)';

// 月→列（1始まり）。J(10)/Q(17)/R(18)/S(19)/T(20)は集計列のため対象外（書き込まない）。
var KANRI_MONTH_COLS = {
  4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  10: 11, 11: 12, 12: 13, 1: 14, 2: 15, 3: 16
};

// 目標管理シートが対象とする会計年度の開始年（2026年4月〜2027年3月）
var KANRI_FISCAL_START_YEAR = 2026;

// 個人ブロック：A列に氏名が入る行番号（診断で確定済み）
var KANRI_PERSON_BLOCKS = [
  { name: '緒方', row: 120 },
  { name: '梅谷', row: 132 },
  { name: '小山', row: 144 },
  { name: '木村', row: 156 },
  { name: '山田', row: 168 },
  { name: '平川', row: 180 },
  { name: '工藤', row: 192 },
  { name: '山口', row: 207 },
  { name: '高山', row: 220 },
  { name: '杉本', row: 232 },
  { name: '田邉', row: 244 },
  { name: '西川', row: 257 },
  { name: '尾上', row: 269 }
];

// 拠点ブロック：A列に拠点名が入る行番号（診断で確定済み）
var KANRI_LOCATION_BLOCKS = [
  { name: '東京', row: 16 },
  { name: '大阪', row: 66 },
  { name: '福岡', row: 81 }
];

// ラベルの表記揺れ吸収。B列との完全一致判定にのみ使う（部分一致は誤ヒットの元なので使わない）。
var KANRI_ITEM_LABELS = {
  売上: ['実績売上高'],
  粗利: ['粗利', '実績粗利'],
  稼働人数: ['実績稼働人数']
};
// 「実績粗利（待機費込み）」は手入力の計算値なので粗利候補から明示的に除外する。
var KANRI_PROFIT_EXCLUDE_LABEL = '実績粗利（待機費込み）';

/**
 * 年月文字列 'YYYY-MM' を目標管理シートの列番号に変換する。
 * 対象会計年度（2026年4月〜2027年3月）の範囲外なら null を返す。
 */
function kanriYmToColumn(ym) {
  var m = String(ym).match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  var year = Number(m[1]);
  var month = Number(m[2]);
  var expectedYear = month >= 4 ? KANRI_FISCAL_START_YEAR : KANRI_FISCAL_START_YEAR + 1;
  if (year !== expectedYear) return null;
  return KANRI_MONTH_COLS[month] || null;
}

/**
 * 実績DBの全行を読み取り、年月を正規化したレコード配列で返す（読み取りのみ）。
 */
function readResultDbRecords(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var headers = CONFIG.RESULT_DB_HEADERS;
  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return rows.map(function (row) {
    var record = {};
    headers.forEach(function (h, c) { record[h] = row[c]; });
    record['年月'] = normalizeYearMonth(record['年月'], ss);
    return record;
  }).filter(function (r) { return r['年月']; });
}

/**
 * (区分, 担当or拠点, 年月) をキーにした索引を作る。
 * 区分='個人'は「担当」、区分='拠点'は「拠点」でマッチさせる。
 */
function buildResultDbIndex(records) {
  var index = {};
  records.forEach(function (r) {
    var name = r['区分'] === CONFIG.RECORD_KIND.PERSON ? r['担当'] : r['拠点'];
    index[[r['区分'], name, r['年月']].join('|')] = r;
  });
  return index;
}

/**
 * 対象ブロック（個人＋拠点）を開始行の昇順に並べ、各ブロックの走査範囲
 * （次のブロック開始行の手前まで、最後のブロックはシート最終行まで）を確定する。
 * 全社・ITS・ENGなど未対象のブロックの行番号は扱わない（対象ブロックの間に
 * 挟まっていても、ラベル完全一致でしか行を特定しないため誤って書き込むことはない）。
 */
function buildKanriBlockRanges(sheet) {
  var blocks = KANRI_PERSON_BLOCKS.map(function (b) {
    return { kind: CONFIG.RECORD_KIND.PERSON, name: b.name, row: b.row };
  }).concat(KANRI_LOCATION_BLOCKS.map(function (b) {
    return { kind: CONFIG.RECORD_KIND.LOCATION, name: b.name, row: b.row };
  }));
  blocks.sort(function (a, b) { return a.row - b.row; });

  var lastRow = sheet.getLastRow();
  return blocks.map(function (block, i) {
    var next = blocks[i + 1];
    return {
      kind: block.kind,
      name: block.name,
      startRow: block.row,
      endRow: next ? next.row - 1 : lastRow
    };
  });
}

/**
 * ブロック範囲内でB列のラベルに完全一致する行を探す。
 * 0件・2件以上の場合は呼び出し側でスキップ扱いにする（誤った行への書き込みを防ぐため、
 * ここでは絶対に「最初の1件」を推測で採用しない）。
 */
function findLabelRows(sheet, startRow, endRow, labels, excludeLabel) {
  var height = endRow - startRow + 1;
  if (height <= 0) return [];
  var values = sheet.getRange(startRow, 2, height, 1).getValues();
  var matches = [];
  values.forEach(function (row, i) {
    var label = String(row[0]).trim();
    if (excludeLabel && label === excludeLabel) return;
    if (labels.indexOf(label) !== -1) matches.push(startRow + i);
  });
  return matches;
}

function groupWritesByRow(plannedWrites) {
  var byRow = {};
  plannedWrites.forEach(function (w) {
    if (!byRow[w.row]) byRow[w.row] = [];
    byRow[w.row].push(w);
  });
  return byRow;
}

/**
 * 書き込み予定を行ごとにまとめ、行内の最小〜最大列の範囲だけを
 * getValues/setValues で一括読み書きする（セル単位の読み書きループは行わない）。
 */
function writePlannedValues(sheet, plannedWrites) {
  var byRow = groupWritesByRow(plannedWrites);
  Object.keys(byRow).forEach(function (rowStr) {
    var row = Number(rowStr);
    var writes = byRow[rowStr];
    var minCol = Math.min.apply(null, writes.map(function (w) { return w.col; }));
    var maxCol = Math.max.apply(null, writes.map(function (w) { return w.col; }));
    var range = sheet.getRange(row, minCol, 1, maxCol - minCol + 1);
    var values = range.getValues()[0];
    writes.forEach(function (w) { values[w.col - minCol] = w.value; });
    range.setValues([values]);
  });
}

/**
 * ドライラン用：書き込み予定の現在値を行単位でまとめて読み取り、指定フォーマットでログ出力する。
 */
function logDryRunDetails(sheet, plannedWrites) {
  var byRow = groupWritesByRow(plannedWrites);
  Object.keys(byRow).map(Number).sort(function (a, b) { return a - b; }).forEach(function (row) {
    var writes = byRow[row];
    var minCol = Math.min.apply(null, writes.map(function (w) { return w.col; }));
    var maxCol = Math.max.apply(null, writes.map(function (w) { return w.col; }));
    var current = sheet.getRange(row, minCol, 1, maxCol - minCol + 1).getValues()[0];
    writes.forEach(function (w) {
      var currentValue = current[w.col - minCol];
      Logger.log(
        '行' + w.row + '列' + w.col + '（' + w.blockName + ' の ' + w.metric + ' / ' + w.ym + '）: ' +
        '現在値=' + currentValue + ' → 書き込む値=' + w.value
      );
    });
  });
}

/**
 * 実績DB → 目標管理シートへの書き戻し本体。
 * dryRun=true のときは一切書き込まずログ出力のみ行う。
 */
function writeBackToKanriSheet(ss, dryRun) {
  if (!dryRun) requireAdmin(ss);

  var sheet = ss.getSheetByName(KANRI_SHEET_NAME);
  if (!sheet) {
    var msg = 'シート「' + KANRI_SHEET_NAME + '」が見つかりません。';
    Logger.log(msg);
    return { planned: 0, skipped: 1, plannedWrites: [], skips: [msg] };
  }

  var blockRanges = buildKanriBlockRanges(sheet);
  var records = readResultDbRecords(ss);
  var recordIndex = buildResultDbIndex(records);

  var yms = {};
  records.forEach(function (r) { yms[r['年月']] = true; });

  var plannedWrites = [];
  var skips = [];

  Object.keys(yms).sort().forEach(function (ym) {
    var col = kanriYmToColumn(ym);
    if (col === null) {
      skips.push(ym + '：目標管理シートの対象年度（2026年4月〜2027年3月）外のためスキップ');
      return;
    }

    blockRanges.forEach(function (block) {
      var record = recordIndex[[block.kind, block.name, ym].join('|')];
      if (!record) {
        skips.push(ym + ' ' + block.name + '：実績DBに該当レコードがないためスキップ');
        return;
      }

      [
        { metric: '売上', value: record['売上'], labels: KANRI_ITEM_LABELS.売上 },
        { metric: '粗利', value: record['粗利'], labels: KANRI_ITEM_LABELS.粗利, exclude: KANRI_PROFIT_EXCLUDE_LABEL },
        { metric: '稼働人数', value: record['稼働人数'], labels: KANRI_ITEM_LABELS.稼働人数 }
      ].forEach(function (item) {
        var matches = findLabelRows(sheet, block.startRow, block.endRow, item.labels, item.exclude);
        if (matches.length === 0) {
          skips.push(
            ym + ' ' + block.name + ' ' + item.metric + '：行' + block.startRow + '〜' + block.endRow +
            'にラベルが見つからないためスキップ'
          );
          return;
        }
        if (matches.length > 1) {
          skips.push(
            ym + ' ' + block.name + ' ' + item.metric + '：ラベルが複数行（' + matches.join(', ') +
            '）に一致したため保留（スキップ）'
          );
          return;
        }
        plannedWrites.push({
          row: matches[0], col: col, blockName: block.name, ym: ym, metric: item.metric, value: item.value
        });
      });
    });
  });

  if (dryRun) {
    logDryRunDetails(sheet, plannedWrites);
    skips.forEach(function (s) { Logger.log('スキップ：' + s); });
    Logger.log('=== 集計 ===');
    Logger.log('書き込み予定件数：' + plannedWrites.length);
    Logger.log('スキップ件数：' + skips.length);
  } else {
    writePlannedValues(sheet, plannedWrites);
  }

  return { planned: plannedWrites.length, skipped: skips.length, plannedWrites: plannedWrites, skips: skips };
}

function ドライラン_目標管理書き戻し() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  writeBackToKanriSheet(ss, true);
}

function 実行_目標管理書き戻し() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);
  var result = writeBackToKanriSheet(ss, false);
  var message =
    '目標管理シートへの書き戻しが完了しました。\n\n' +
    '書き込み件数：' + result.planned + '\n' +
    'スキップ件数：' + result.skipped + '\n\n' +
    'スキップ内容：\n' + (result.skips.length > 0 ? result.skips.join('\n') : '（なし）');
  SpreadsheetApp.getUi().alert(message);
}
