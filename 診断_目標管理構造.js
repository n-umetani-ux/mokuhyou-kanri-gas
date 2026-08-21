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
