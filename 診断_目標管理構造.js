function 診断_目標管理シート構造() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = '目標管理（2026年4月～3月末)';
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log('シート「' + sheetName + '」が見つかりません。存在するシート一覧：');
    ss.getSheets().forEach(function (s) { Logger.log('  - ' + s.getName()); });
    return;
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  Logger.log('シート「' + sheetName + '」：' + lastRow + '行 x ' + lastCol + '列');

  var allValues = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  Logger.log('=== 月ヘッダ候補（「年」かつ「月」を含むセル） ===');
  for (var r = 0; r < allValues.length; r++) {
    for (var c = 0; c < allValues[r].length; c++) {
      var v = String(allValues[r][c]);
      if (v.indexOf('年') !== -1 && v.indexOf('月') !== -1) {
        Logger.log('行' + (r + 1) + ' 列' + columnToLetter(c + 1) + '(' + (c + 1) + ')：[' + v + ']');
      }
    }
  }

  Logger.log('=== A列・B列のラベル一覧（行番号付き） ===');
  for (var r2 = 0; r2 < allValues.length; r2++) {
    var a = allValues[r2][0];
    var b = allValues[r2][1];
    if (a || b) {
      Logger.log('行' + (r2 + 1) + '：A=[' + a + '] B=[' + b + ']');
    }
  }
}

function columnToLetter(column) {
  var temp, letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

function 診断_目標管理シート月列() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = '目標管理（2026年4月～3月末)';
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log('シート「' + sheetName + '」が見つかりません。');
    return;
  }

  var lastCol = sheet.getLastColumn();

  // ブロックのタイトル行（前回の診断で判明した行番号）を横方向に全列スキャンする
  var titleRows = [2, 16, 34, 52, 66, 81, 119, 132, 144, 156];

  titleRows.forEach(function (row) {
    Logger.log('=== 行' + row + ' の全列（1〜' + lastCol + '列）===');
    var values = sheet.getRange(row, 1, 1, lastCol).getValues()[0];
    for (var c = 0; c < values.length; c++) {
      var v = values[c];
      var type = Object.prototype.toString.call(v);
      var display = v;
      if (type === '[object Date]') {
        display = Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd') +
          '（年=' + v.getFullYear() + ' 月=' + (v.getMonth() + 1) + '）';
      }
      if (v !== '' && v !== null) {
        Logger.log('  列' + columnToLetter(c + 1) + '(' + (c + 1) + ')：型=' + type + ' 値=[' + display + ']');
      }
    }
  });

  // 実績売上高の行（全社ブロック、行6）も同様に全列ダンプして、値が入っている列を確認する
  Logger.log('=== 行6（全社・実績売上高）の全列 ===');
  var salesRow = sheet.getRange(6, 1, 1, lastCol).getValues()[0];
  for (var c2 = 0; c2 < salesRow.length; c2++) {
    if (salesRow[c2] !== '' && salesRow[c2] !== null) {
      Logger.log('  列' + columnToLetter(c2 + 1) + '(' + (c2 + 1) + ')：値=[' + salesRow[c2] + ']');
    }
  }
}
