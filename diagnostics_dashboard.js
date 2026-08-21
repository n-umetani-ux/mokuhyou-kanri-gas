/**
 * ダッシュボードシート設計のための実データ構造確認用診断関数。
 * 実績DB・目標DB・担当マスタへは一切書き込まない（読み取り専用）。
 */
function 診断_実績DB構造() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Logger.log('=== 実績DB：区分×拠点×セクション×担当 の distinct 一覧（件数付き） ===');
  try {
    var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
    if (!sheet || sheet.getLastRow() < 2) {
      Logger.log('実績DBにデータがありません。');
    } else {
      var headers = CONFIG.RESULT_DB_HEADERS;
      var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
      var kindIdx = headers.indexOf('区分');
      var locIdx = headers.indexOf('拠点');
      var secIdx = headers.indexOf('セクション');
      var personIdx = headers.indexOf('担当');
      var ymIdx = headers.indexOf('年月');

      var combo = {};
      rows.forEach(function (row) {
        var key = '区分=[' + row[kindIdx] + '] 拠点=[' + row[locIdx] + '] セクション=[' + row[secIdx] + '] 担当=[' + row[personIdx] + ']';
        combo[key] = (combo[key] || 0) + 1;
      });
      Object.keys(combo).sort().forEach(function (key) {
        Logger.log(key + ' … ' + combo[key] + '件');
      });

      Logger.log('=== 実績DB：年月ごとのレコード件数 ===');
      var byYm = {};
      rows.forEach(function (row) {
        var ym = normalizeYearMonth(row[ymIdx], ss);
        byYm[ym] = (byYm[ym] || 0) + 1;
      });
      Object.keys(byYm).sort().forEach(function (ym) {
        Logger.log(ym + ' … ' + byYm[ym] + '件');
      });

      Logger.log('=== 実績DB：2026-08 の全レコード ===');
      var target = '2026-08';
      var matched = rows.filter(function (row) {
        return normalizeYearMonth(row[ymIdx], ss) === target;
      });
      if (matched.length === 0) {
        Logger.log('2026-08 のレコードはありません。');
      } else {
        matched.forEach(function (row) {
          var line = headers.map(function (h, i) {
            return h + '=[' + row[i] + ']';
          }).join(' ');
          Logger.log(line);
        });
        Logger.log('2026-08 レコード数：' + matched.length + '件');
      }
    }
  } catch (e) {
    Logger.log('実績DB確認エラー：' + e.message);
  }

  Logger.log('=== 目標DB：ヘッダ行とデータ行 ===');
  try {
    var targetDbSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.TARGET_DB);
    if (!targetDbSheet) {
      Logger.log('目標DBシートが見つかりません。');
    } else {
      var lastRow = targetDbSheet.getLastRow();
      var lastCol = targetDbSheet.getLastColumn();
      if (lastRow === 0 || lastCol === 0) {
        Logger.log('目標DBシートは空です。');
      } else {
        Logger.log('1行目（注記）：' + JSON.stringify(targetDbSheet.getRange(1, 1, 1, lastCol).getValues()[0]));
        if (lastRow >= 2) {
          Logger.log('2行目（ヘッダ）：' + JSON.stringify(targetDbSheet.getRange(2, 1, 1, lastCol).getValues()[0]));
        } else {
          Logger.log('2行目（ヘッダ）はありません。');
        }
        if (lastRow >= 3) {
          var dataRows = targetDbSheet.getRange(3, 1, lastRow - 2, lastCol).getValues();
          dataRows.forEach(function (row, i) {
            Logger.log((i + 3) + '行目：' + JSON.stringify(row));
          });
        } else {
          Logger.log('データ行（3行目以降）はありません。');
        }
      }
    }
  } catch (e) {
    Logger.log('目標DB確認エラー：' + e.message);
  }
}
