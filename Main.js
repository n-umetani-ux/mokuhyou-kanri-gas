/**
 * 稼働データ転記 v2.4 — 転記本体
 *
 * v1.8までの「目標管理シートのセル番地に直接書き込む」方式をやめ、
 * 縦持ちの実績DBへ upsert する方式に変更した。
 * v2.1 で担当マスタの在籍判定を「在籍終了年月」ベースに変更し、
 * 実績DBから目標売上・目標粗利を分離した（目標DBシートへ、手入力専用）。
 * v2.2 で年月文字列がスプレッドシート側で日付に自動変換され upsert のキー一致が
 * 崩れる不具合を修正した（normalizeYearMonth、テキスト書式、重複行の検出・修復）。
 * v2.3 で検証処理を「実績DBの行のみを集計し担当マスタは参照しない」方針に統一し、
 * 個人合計と拠点の差額は構造的な不整合（待機・キー重複・目標列残存）とは分けて
 * 情報（INFO）として内訳付きで報告するようにした。
 * v2.4 で determineTargetMonths が forceOverwrite を受け取らず、確定済みの過去月が
 * 強制上書きでも対象月に入らない不具合を修正した。「対象月の決定」（forceOverwriteで
 * 範囲が変わる）と「上書きの可否」（状態=確定の行を書き換えてよいか）を明確に分離し、
 * 転記結果に強制上書きの有無・対象月一覧・月別の新規/更新/スキップ件数を出すようにした。
 * 対象月の決定・締め判定・書き込み先の詳細は README.md を参照。
 */

function pad2(n) {
  return ('0' + n).slice(-2);
}

function ymKey(year, month) {
  return year + '-' + pad2(month);
}

function addMonths(year, month, delta) {
  var total = year * 12 + (month - 1) + delta;
  var y = Math.floor(total / 12);
  var m = total - y * 12 + 1;
  return { year: y, month: m };
}

function compareYm(a, b) {
  return (a.year * 12 + a.month) - (b.year * 12 + b.month);
}

function getFiscalYearMonths(baseDate) {
  var y = baseDate.getFullYear();
  var m = baseDate.getMonth() + 1;
  var fyStartYear = m >= 4 ? y : y - 1;
  var months = [];
  for (var i = 0; i < 12; i++) {
    months.push(addMonths(fyStartYear, 4, i));
  }
  return months;
}

/**
 * 対象月（＝この月の稼働一覧ファイルを読みにいくかどうか）を決定する。
 *
 * これは「上書きの可否」（実績DB上の個々の行を書き換えてよいか）とは別の条件である。
 * 対象月に含まれていても、状態=確定の行は forceOverwrite=false の限り上書きしない
 * （その判定は runTranscribe 側で個別に行う）。
 *
 * - forceOverwrite = false：前月・当月・翌月 ∪ 当年度内で実績DBが「確定」になっていない過去月。
 * - forceOverwrite = true ：実績DBの状態は一切参照せず、当年度（4月〜翌3月）の全月を対象とする。
 *   ファイルが実在するかどうかは runTranscribe 側の findKakudoFile 判定に委ねる
 *   （ここでは存在確認を行わない）。
 */
function determineTargetMonths(ss, today, forceOverwrite) {
  var fiscalMonths = getFiscalYearMonths(today);

  if (forceOverwrite) {
    var forced = fiscalMonths.slice();
    forced.sort(compareYm);
    return forced;
  }

  var thisYear = today.getFullYear();
  var thisMonth = today.getMonth() + 1;
  var current = { year: thisYear, month: thisMonth };

  var base = [
    addMonths(thisYear, thisMonth, -1),
    current,
    addMonths(thisYear, thisMonth, 1)
  ];

  var statusMap = getMonthStatusMap(ss);
  var pastUnfinalized = fiscalMonths.filter(function (ym) {
    return compareYm(ym, current) < 0 && statusMap[ymKey(ym.year, ym.month)] !== CONFIG.STATUS.FINALIZED;
  });

  var all = base.concat(pastUnfinalized);
  var seen = {};
  var result = [];
  all.forEach(function (ym) {
    var key = ymKey(ym.year, ym.month);
    if (!seen[key]) {
      seen[key] = true;
      result.push(ym);
    }
  });
  result.sort(compareYm);
  return result;
}

function mergeRecord(base, extra) {
  var record = {};
  Object.keys(base).forEach(function (k) { record[k] = base[k]; });
  Object.keys(extra).forEach(function (k) { record[k] = extra[k]; });
  return record;
}

/**
 * 個人数字・稼働表（東京）の生データから 実績DB 行のレコード群を構築する。
 * 値は加工せず素のまま転記する（符号反転・待機の加減算などは行わない）。
 */
function buildRecords(ym, grid, waitBreakdown, activeStaff, fileName, fileStatus, warnings) {
  var col = CONFIG.KOJIN_COL;
  var base = {
    年月: normalizeYearMonth(ym),
    状態: fileStatus.status,
    確定日: fileStatus.finalizedDate,
    転記元ファイル名: fileName,
    転記日時: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
  };
  var records = [];

  activeStaff.forEach(function (person) {
    var row = person.kojinRow;
    var actualName = String(grid[row - 1][col.NAME - 1] || '').trim();
    if (actualName !== person.name) {
      warnings.push(
        ym + '：担当マスタ「' + person.name + '」(個人数字' + row + '行目) の氏名が一致しません' +
        '（実際の値：「' + actualName + '」）。この担当はスキップしました。'
      );
      return;
    }
    records.push(mergeRecord(base, {
      区分: CONFIG.RECORD_KIND.PERSON,
      拠点: person.location,
      セクション: '',
      担当: person.name,
      稼働人数: cellValue(grid, row, col.TOTAL_STAFF),
      売上: cellValue(grid, row, col.SALES_TOTAL),
      粗利: cellValue(grid, row, col.PROFIT_TOTAL),
      待機原価: cellValue(grid, row, col.WAIT_PROFIT),
      BP数: cellValue(grid, row, col.BP_CASE) + cellValue(grid, row, col.BP_JINZAI)
    }));
  });

  CONFIG.BLOCKS.forEach(function (block) {
    var row = block.totalRow;
    records.push(mergeRecord(base, {
      区分: CONFIG.RECORD_KIND.LOCATION,
      拠点: block.name,
      セクション: '',
      担当: '',
      稼働人数: cellValue(grid, row, col.TOTAL_STAFF),
      売上: cellValue(grid, row, col.SALES_TOTAL),
      粗利: cellValue(grid, row, col.PROFIT_TOTAL),
      待機原価: cellValue(grid, row, col.WAIT_PROFIT),
      BP数: cellValue(grid, row, col.BP_CASE) + cellValue(grid, row, col.BP_JINZAI)
    }));
  });

  CONFIG.SECTION_BLOCKS.forEach(function (sec) {
    var block = CONFIG.BLOCKS.filter(function (b) { return b.name === sec.block; })[0];
    var row = block.totalRow;
    records.push(mergeRecord(base, {
      区分: CONFIG.RECORD_KIND.SECTION,
      拠点: sec.block,
      セクション: sec.section,
      担当: '',
      稼働人数: cellValue(grid, row, col.ENG_STAFF),
      売上: cellValue(grid, row, col.SALES_ENG),
      粗利: cellValue(grid, row, col.PROFIT_ENG)
    }));
  });

  if (waitBreakdown) {
    CONFIG.WAIT_CATEGORIES.forEach(function (cat) {
      records.push(mergeRecord(base, {
        区分: CONFIG.RECORD_KIND.WAITING,
        拠点: CONFIG.WAIT_LOCATION,
        セクション: cat.toUpperCase(),
        担当: '',
        待機人数: waitBreakdown[cat].count,
        待機原価: waitBreakdown[cat].cost
      }));
    });
  }

  return records;
}

/**
 * 転記処理本体。Menu.gs のハンドラからのみ呼び出される想定。
 */
function runTranscribe(ss, forceOverwrite) {
  requireAdmin(ss);

  var driveFolderId = getDriveFolderId(ss);
  migrateResultDbRemoveTargetColumns(ss);
  ensureTargetDbSheet(ss);

  var warnings = migrateStaffMasterActiveColumn(ss);
  var staffMaster = getStaffMaster(ss);

  // 対象月の決定（forceOverwrite で範囲が変わる）と、個々の行の上書き可否
  // （状態=確定なら forceOverwrite=false の間は上書きしない）は別の条件。
  var targetMonths = determineTargetMonths(ss, new Date(), forceOverwrite);
  var statusMap = getMonthStatusMap(ss);

  var confirmedMonths = [];
  var provisionalMonths = [];
  var skipped = [];
  var errors = [];
  var totalProcessed = 0;
  var monthBreakdown = []; // 月ごとの新規追加/更新/スキップ件数を可視化するための内訳

  targetMonths.forEach(function (target) {
    var ym = ymKey(target.year, target.month);

    // ここが「上書きの可否」の判定。対象月に入っていることとは別条件で、
    // 状態=確定の月は forceOverwrite=true のときのみ上書きする。
    if (!forceOverwrite && statusMap[ym] === CONFIG.STATUS.FINALIZED) {
      skipped.push(ym + '：確定済みのためスキップ');
      monthBreakdown.push(ym + '：スキップ（確定のため上書きせず）');
      return;
    }

    try {
      var file = findKakudoFile(driveFolderId, target.year, target.month);
      if (!file) {
        skipped.push(ym + '：ファイルなし');
        monthBreakdown.push(ym + '：スキップ（ファイルなし）');
        return;
      }

      var fileName = file.getName();
      var fileStatus = parseFileStatus(fileName);
      var kakudoSS = SpreadsheetApp.openById(file.getId());

      var grid = readKojinSujiGrid(kakudoSS);
      if (!grid) {
        skipped.push(ym + '：「' + CONFIG.SOURCE_SHEET_NAMES.KOJIN_SUJI + '」シートが見つかりません');
        monthBreakdown.push(ym + '：スキップ（「' + CONFIG.SOURCE_SHEET_NAMES.KOJIN_SUJI + '」シートなし）');
        return;
      }

      var waitBreakdown = readWaitBreakdown(kakudoSS);
      if (!waitBreakdown) {
        warnings.push(ym + '：「' + CONFIG.SOURCE_SHEET_NAMES.TOKYO_TABLE + '」の待機集計が取得できませんでした');
      }

      var activeStaff = getActiveStaffForYm(staffMaster, ym);
      var records = buildRecords(ym, grid, waitBreakdown, activeStaff, fileName, fileStatus, warnings);
      var upsertResult = upsertResultDb(ss, records);
      totalProcessed += records.length;
      monthBreakdown.push(ym + '：新規' + upsertResult.inserted + '件/更新' + upsertResult.updated + '件');

      if (fileStatus.status === CONFIG.STATUS.FINALIZED) {
        confirmedMonths.push(ym);
      } else {
        provisionalMonths.push(ym);
      }
    } catch (e) {
      errors.push(ym + '：' + e.message);
      monthBreakdown.push(ym + '：エラー（' + e.message + '）');
    }
  });

  removeRecordsPastEndDate(ss, staffMaster);

  var duplicates = findResultDbDuplicateGroups(ss);
  if (duplicates.excessRowCount > 0) {
    var duplicateMessage = 'キー重複あり: ' + duplicates.excessRowCount + '件';
    warnings.push(duplicateMessage);
    errors.push(duplicateMessage);
    Logger.log('エラー：' + duplicateMessage + '（修復_重複行削除() の実行を検討してください）');
  }

  var targetMonthList = targetMonths.map(function (t) { return ymKey(t.year, t.month); }).join(', ');

  appendLog(ss, {
    実行日時: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
    実行者: Session.getActiveUser().getEmail(),
    強制上書き: forceOverwrite ? 'はい' : 'いいえ',
    対象月: targetMonthList,
    確定月: confirmedMonths.join(', '),
    暫定月: provisionalMonths.join(', '),
    処理件数: totalProcessed,
    月別内訳: monthBreakdown.join(' / '),
    スキップ内容: skipped.join(' / '),
    警告: warnings.join(' / '),
    エラー: errors.join(' / ')
  });

  var message = '転記処理が完了しました\n\n' +
    '強制上書き：' + (forceOverwrite ? 'はい' : 'いいえ') + '\n' +
    '対象月一覧：' + targetMonthList + '\n' +
    '処理件数：' + totalProcessed + '件\n' +
    (confirmedMonths.length ? '確定：' + confirmedMonths.join(', ') + '\n' : '') +
    (provisionalMonths.length ? '暫定：' + provisionalMonths.join(', ') + '\n' : '') +
    (monthBreakdown.length ? '\n月別内訳：\n' + monthBreakdown.join('\n') : '') +
    (skipped.length ? '\nスキップ：\n' + skipped.join('\n') : '') +
    (warnings.length ? '\n警告：\n' + warnings.join('\n') : '') +
    (errors.length ? '\nエラー：\n' + errors.join('\n') : '');

  SpreadsheetApp.getUi().alert(message);
}

/**
 * 実績DBのキー重複行（年月＋区分＋拠点＋セクション＋担当が同一の行）を修復する。
 * 各キーについて 転記日時 が最新の1行だけを残し、他は削除する。
 * 削除前に削除件数・削除対象キーの一覧を先にログへ出してから削除を実行する。
 */
function 修復_重複行削除() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);

  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('実績DBにデータがありません。');
    return;
  }

  var headers = CONFIG.RESULT_DB_HEADERS;
  var timestampIdx = headers.indexOf('転記日時');
  var dup = findResultDbDuplicateGroups(ss);

  Logger.log('=== 修復_重複行削除：削除予定 ===');
  Logger.log('重複キー数：' + dup.duplicateKeys.length + '　削除予定行数：' + dup.excessRowCount);
  if (dup.duplicateKeys.length > 0) {
    Logger.log(dup.duplicateKeys.join('\n'));
  }

  if (dup.excessRowCount === 0) {
    Logger.log('重複はありませんでした。');
    return;
  }

  var kept = [];
  Object.keys(dup.groups).forEach(function (key) {
    var group = dup.groups[key];
    var latest = group[0];
    group.forEach(function (row) {
      if (String(row[timestampIdx]) > String(latest[timestampIdx])) {
        latest = row;
      }
    });
    kept.push(latest);
  });

  writeResultDbRows(sheet, kept);

  Logger.log('=== 修復_重複行削除：削除完了 ===');
  Logger.log('削除件数：' + dup.excessRowCount + '件');
}

/**
 * 稼働一覧ファイルが見つからない不具合の切り分け用診断関数。
 * 実データには一切書き込まず、Logger.log に出力するだけの読み取り専用関数。
 */
function 診断_ファイル検索() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var driveFolderId = null;
  var fileNames = [];
  var patterns = [];

  Logger.log('=== ステップ1: 設定シート ===');
  try {
    var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.SETTINGS);
    if (!sheet) {
      throw new Error('「' + CONFIG.SHEET_NAMES.SETTINGS + '」シートが見つかりません。');
    }
    var values = sheet.getDataRange().getValues();
    for (var i = 0; i < values.length; i++) {
      Logger.log('key=[' + values[i][0] + '] value=[' + values[i][1] + ']');
    }
  } catch (e) {
    Logger.log('ステップ1エラー：' + e.message);
  }

  Logger.log('=== ステップ2: driveFolderId ===');
  try {
    driveFolderId = getDriveFolderId(ss);
    Logger.log('driveFolderId=[' + driveFolderId + '] 文字数=' + String(driveFolderId).length);
  } catch (e) {
    Logger.log('ステップ2エラー：' + e.message);
  }

  Logger.log('=== ステップ3: フォルダ取得 ===');
  var folder = null;
  try {
    folder = DriveApp.getFolderById(driveFolderId);
    Logger.log('フォルダ名：' + folder.getName());
  } catch (e) {
    Logger.log('ステップ3エラー：' + e.message);
  }

  Logger.log('=== ステップ4: フォルダ直下のファイル一覧（最大50件） ===');
  try {
    if (!folder) {
      throw new Error('フォルダが取得できていないため一覧取得をスキップします。');
    }
    var files = folder.getFiles();
    var count = 0;
    while (files.hasNext() && count < 50) {
      var f = files.next();
      fileNames.push(f.getName());
      Logger.log((count + 1) + ': ' + f.getName());
      count++;
    }
    if (count === 0) {
      Logger.log('（ファイルなし）');
    }

    var folders = folder.getFolders();
    while (folders.hasNext()) {
      Logger.log('[サブフォルダ] ' + folders.next().getName());
    }
  } catch (e) {
    Logger.log('ステップ4エラー：' + e.message);
  }

  Logger.log('=== ステップ5: 検索文字列（2026年8月） ===');
  try {
    var zeroPadded = CONFIG.FILE_NAME_PREFIX + '2026' + '年' + '08' + '月度';
    var nonPadded = CONFIG.FILE_NAME_PREFIX + '2026' + '年' + '8' + '月度';
    patterns = [zeroPadded, nonPadded];
    Logger.log('ゼロ埋めあり：[' + zeroPadded + ']');
    Logger.log('ゼロ埋めなし：[' + nonPadded + ']');
  } catch (e) {
    Logger.log('ステップ5エラー：' + e.message);
  }

  Logger.log('=== ステップ6: 前方一致テスト ===');
  try {
    if (fileNames.length === 0) {
      throw new Error('ステップ4で取得したファイル名がないためスキップします。');
    }
    if (patterns.length === 0) {
      throw new Error('ステップ5で検索文字列が作成されていないためスキップします。');
    }
    patterns.forEach(function (pattern) {
      var normalizedPattern = normalizeZenkaku(pattern);
      var hit = fileNames.filter(function (name) {
        return normalizeZenkaku(name).indexOf(normalizedPattern) === 0;
      });
      Logger.log('パターン[' + pattern + '] → ' + (hit.length > 0 ? hit.join(', ') : '該当なし'));
    });
  } catch (e) {
    Logger.log('ステップ6エラー：' + e.message);
  }
}

/**
 * 担当マスタの在籍終了年月判定が想定通り動いているかを切り分ける診断関数。
 * 実データには一切書き込まず、Logger.log に出力するだけの読み取り専用関数。
 * 原因特定のための診断のみで、ここではロジックの修正は行わない。
 */
function 診断_担当マスタ判定() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var staffMaster = [];

  Logger.log('=== ステップ1: 担当マスタの生の値 ===');
  try {
    var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STAFF_MASTER);
    if (!sheet) {
      throw new Error('「' + CONFIG.SHEET_NAMES.STAFF_MASTER + '」シートが見つかりません。');
    }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      Logger.log('担当マスタにデータがありません。');
    } else {
      // 列位置は固定せずヘッダ名で解決する（セクション列追加後も列ラベルがずれないようにするため）。
      var lastCol = sheet.getLastColumn();
      var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
        .map(function (h) { return String(h).trim(); });
      var locationCol = headerRow.indexOf('拠点');
      var kojinRowCol = headerRow.indexOf('個人数字の行');
      var endYmCol = headerRow.indexOf('在籍終了年月');
      var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      values.forEach(function (row) {
        if (!row[0]) return;
        var endYmRaw = row[endYmCol];
        Logger.log(
          '氏名=[' + row[0] + '] 拠点=' + row[locationCol] + ' 個人数字の行=' + row[kojinRowCol] +
          ' 在籍終了年月：typeof=' + (typeof endYmRaw) +
          ' 生の値=' + endYmRaw +
          ' 文字列化=[' + String(endYmRaw) + ']' +
          ' normalize後=[' + normalizeYearMonth(endYmRaw, ss) + ']'
        );
      });
    }
  } catch (e) {
    Logger.log('ステップ1エラー：' + e.message);
  }

  Logger.log('=== ステップ2: 判定結果のマトリクス（2026-04〜2026-09） ===');
  try {
    staffMaster = getStaffMaster(ss);
    if (staffMaster.length === 0) {
      throw new Error('担当マスタの読み取り結果が空です（getStaffMaster）。');
    }
    for (var month = 4; month <= 9; month++) {
      var ym = ymKey(2026, month);
      staffMaster.forEach(function (person) {
        var endYm = normalizeYearMonth(person.endYm);
        var result = isStaffActiveForYm(person, ym);
        Logger.log(
          ym + '　' + person.name + '　在籍終了年月(正規化後)=[' + endYm + ']　比較：' +
          ym + ' <= ' + (endYm || '(空欄)') + '　判定=' + (result ? '対象' : '除外')
        );
      });
    }

    var tanabe = staffMaster.filter(function (p) { return p.name === '田邉'; })[0];
    if (tanabe) {
      Logger.log(
        '田邉の確認：\'2026-04\' <= \'' + normalizeYearMonth(tanabe.endYm) + '\' → ' +
        ('2026-04' <= normalizeYearMonth(tanabe.endYm))
      );
    } else {
      Logger.log('担当マスタに「田邉」が見つかりません（氏名の表記ゆれの可能性）。');
    }
  } catch (e) {
    Logger.log('ステップ2エラー：' + e.message);
  }

  Logger.log('=== ステップ3: 転記対象リストの実際の中身（2026-04） ===');
  try {
    if (staffMaster.length === 0) {
      throw new Error('ステップ2で担当マスタが取得できていないためスキップします。');
    }
    var activeStaffApril = getActiveStaffForYm(staffMaster, ymKey(2026, 4));
    Logger.log('2026-04 転記対象：' + activeStaffApril.map(function (p) { return p.name; }).join(', '));
    Logger.log('田邉を含むか：' + activeStaffApril.some(function (p) { return p.name === '田邉'; }));
  } catch (e) {
    Logger.log('ステップ3エラー：' + e.message);
  }

  Logger.log('=== ステップ4: 個人数字からの読み取り（2026-04・田邉） ===');
  try {
    var tanabeMaster = staffMaster.filter(function (p) { return p.name === '田邉'; })[0];
    if (!tanabeMaster) {
      throw new Error('担当マスタに「田邉」が見つからないためスキップします。');
    }

    var driveFolderId = getDriveFolderId(ss);
    var file = findKakudoFile(driveFolderId, 2026, 4);
    if (!file) {
      throw new Error('2026年04月度の稼働一覧ファイルが見つかりません。');
    }

    var kakudoSS = SpreadsheetApp.openById(file.getId());
    var grid = readKojinSujiGrid(kakudoSS);
    if (!grid) {
      throw new Error('「' + CONFIG.SOURCE_SHEET_NAMES.KOJIN_SUJI + '」シートが見つかりません。');
    }

    var col = CONFIG.KOJIN_COL;
    var row = tanabeMaster.kojinRow;
    var actualName = String(grid[row - 1][col.NAME - 1] || '').trim();
    var sales = cellValue(grid, row, col.SALES_TOTAL);
    var profit = cellValue(grid, row, col.PROFIT_TOTAL);
    var totalStaff = cellValue(grid, row, col.TOTAL_STAFF);

    Logger.log(
      '個人数字' + row + '行目：A列氏名=[' + actualName + '] 総数(J列)=' + totalStaff +
      ' 売上(W列)=' + sales + ' 粗利(AH列)=' + profit
    );
    Logger.log(
      'マスタ氏名[' + tanabeMaster.name + '] === A列氏名[' + actualName + '] → ' +
      (tanabeMaster.name === actualName)
    );
  } catch (e) {
    Logger.log('ステップ4エラー：' + e.message);
  }
}

/**
 * 転記対象に含まれる担当のレコードが実績DBへ書き込まれない件の診断関数。
 * 実データには一切書き込まず、Logger.log に出力するだけの読み取り専用関数。
 * 引数省略時は '2026-04' を対象とする。診断のみで、ロジックの修正は行わない。
 */
function 診断_書き込み経路(ym) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ym = normalizeYearMonth(ym || '2026-04', ss) || '2026-04';
  var parts = ym.split('-');
  var year = Number(parts[0]);
  var month = Number(parts[1]);

  Logger.log('=== 対象月選定の確認（determineTargetMonths） ===');
  try {
    var normalTargets = determineTargetMonths(ss, new Date(), false).map(function (t) { return ymKey(t.year, t.month); });
    var forcedTargets = determineTargetMonths(ss, new Date(), true).map(function (t) { return ymKey(t.year, t.month); });
    Logger.log('通常モードの対象月一覧：' + normalTargets.join(', '));
    Logger.log('強制上書きモードの対象月一覧：' + forcedTargets.join(', '));
    Logger.log(ym + ' は通常モードで対象月に含まれるか：' + (normalTargets.indexOf(ym) !== -1));
    Logger.log(ym + ' は強制上書きモードで対象月に含まれるか：' + (forcedTargets.indexOf(ym) !== -1));

    var statusMap = getMonthStatusMap(ss);
    Logger.log(ym + ' の実績DB上の現在の状態（状態列）：' + (statusMap[ym] || '（実績DBに行なし、または状態未設定）'));
  } catch (e) {
    Logger.log('対象月選定確認エラー：' + e.message);
  }

  var records = [];
  Logger.log('=== ステップ1: レコード生成 ===');
  try {
    var driveFolderId = getDriveFolderId(ss);
    var file = findKakudoFile(driveFolderId, year, month);
    if (!file) {
      throw new Error(ym + ' の稼働一覧ファイルが見つかりません。');
    }
    var fileName = file.getName();
    var fileStatus = parseFileStatus(fileName);
    var kakudoSS = SpreadsheetApp.openById(file.getId());

    var grid = readKojinSujiGrid(kakudoSS);
    if (!grid) {
      throw new Error('「' + CONFIG.SOURCE_SHEET_NAMES.KOJIN_SUJI + '」シートが見つかりません。');
    }
    var waitBreakdown = readWaitBreakdown(kakudoSS);

    var staffMaster = getStaffMaster(ss);
    var activeStaff = getActiveStaffForYm(staffMaster, ym);
    var warnings = [];
    records = buildRecords(ym, grid, waitBreakdown, activeStaff, fileName, fileStatus, warnings);

    var personRecords = records.filter(function (r) { return r.区分 === CONFIG.RECORD_KIND.PERSON; });
    Logger.log('生成レコード総数：' + records.length);
    Logger.log('個人レコードの担当名：' + personRecords.map(function (r) { return r.担当; }).join(', '));

    var tanabeRecord = personRecords.filter(function (r) { return r.担当 === '田邉'; })[0];
    Logger.log('田邉のレコードが含まれるか：' + !!tanabeRecord);
    if (tanabeRecord) {
      Logger.log('田邉のレコード内容：' + JSON.stringify(tanabeRecord));
    }
    if (warnings.length > 0) {
      Logger.log('buildRecords が出した警告：' + warnings.join(' / '));
    }
  } catch (e) {
    Logger.log('ステップ1エラー：' + e.message);
  }

  Logger.log('=== ステップ2: 除外・スキップ判定のトレース ===');
  try {
    var osakaBlock = CONFIG.BLOCKS.filter(function (b) { return b.name === '大阪'; })[0];
    Logger.log('Config.gs 上の大阪ブロックの個人行範囲（personRows）：' + JSON.stringify(osakaBlock.personRows));
    Logger.log(
      '個人レコードは activeStaff.forEach 内で person.kojinRow（担当マスタの「個人数字の行」）を' +
      '直接使って生成しており、CONFIG.BLOCKS[].personRows はこのループのどこからも参照されていない' +
      '（コード内に使用箇所なし＝未使用の定数）。したがって block.personRows の範囲が' +
      '個人レコードの生成に影響することはない。'
    );
    Logger.log(
      '売上・粗利・稼働人数が0または空の担当をスキップする処理：buildRecords 内には存在しない（該当なし）。'
    );
    Logger.log(
      '在籍終了年月が設定されている担当を月に関係なく除外する処理：isStaffActiveForYm は' +
      '対象年月と在籍終了年月を比較する実装のみで、月に関係なく一律除外する処理は存在しない（該当なし）。'
    );
    Logger.log(
      'buildRecords 内で個人レコードがスキップされる唯一の分岐は、' +
      '担当マスタの氏名と個人数字シートA列の氏名が一致しない場合（actualName !== person.name）のみ。'
    );
  } catch (e) {
    Logger.log('ステップ2エラー：' + e.message);
  }

  Logger.log('=== ステップ3: upsertの動作（ドライラン・書き込みなし） ===');
  try {
    var tanabeRecordForUpsert = records.filter(function (r) {
      return r.区分 === CONFIG.RECORD_KIND.PERSON && r.担当 === '田邉';
    })[0];
    if (!tanabeRecordForUpsert) {
      throw new Error('ステップ1で田邉のレコードが生成されていないため、upsertのドライランをスキップします。');
    }

    var headers = CONFIG.RESULT_DB_HEADERS;
    var ymCol = headers.indexOf('年月');
    var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
    var lastRow = sheet ? sheet.getLastRow() : 0;
    var existingRows = (sheet && lastRow > 1) ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

    existingRows.forEach(function (row) {
      row[ymCol] = normalizeYearMonth(row[ymCol], ss);
    });

    var keyIndex = {};
    existingRows.forEach(function (row, i) {
      var record = {};
      headers.forEach(function (h, c) { record[h] = row[c]; });
      keyIndex[buildResultDbKey(record, ss)] = i;
    });

    var key = buildResultDbKey(tanabeRecordForUpsert, ss);
    var rowArray = headers.map(function (h) {
      return tanabeRecordForUpsert[h] === undefined ? '' : tanabeRecordForUpsert[h];
    });

    Logger.log('組み立てたキー：[' + key + ']');
    if (Object.prototype.hasOwnProperty.call(keyIndex, key)) {
      var existingIndex = keyIndex[key];
      Logger.log('既存行の検索結果：見つかった（配列インデックス=' + existingIndex + '　実際のシート行番号=' + (existingIndex + 2) + '）');
      Logger.log('この行が次の値で上書きされる予定：' + JSON.stringify(rowArray));
    } else {
      Logger.log('既存行の検索結果：見つからない → 新規追加');
      Logger.log('新規追加される予定の行番号（末尾追加）：' + (existingRows.length + 2));
      Logger.log('書き込む予定の値：' + JSON.stringify(rowArray));
    }
    Logger.log('※このステップはドライランです。実際の書き込みは行っていません。');
  } catch (e) {
    Logger.log('ステップ3エラー：' + e.message);
  }

  Logger.log('=== ステップ4: 実績DBの現状（' + ym + '・区分=個人） ===');
  try {
    var headers2 = CONFIG.RESULT_DB_HEADERS;
    var sheet2 = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
    if (!sheet2 || sheet2.getLastRow() < 2) {
      throw new Error('実績DBにデータがありません。');
    }
    var rows2 = sheet2.getRange(2, 1, sheet2.getLastRow() - 1, headers2.length).getValues();
    var ymIdx2 = headers2.indexOf('年月');
    var kindIdx2 = headers2.indexOf('区分');
    var personIdx2 = headers2.indexOf('担当');
    var salesIdx2 = headers2.indexOf('売上');

    var found = [];
    rows2.forEach(function (row, i) {
      var rowYm = normalizeYearMonth(row[ymIdx2], ss);
      if (rowYm === ym && row[kindIdx2] === CONFIG.RECORD_KIND.PERSON) {
        found.push('シート行' + (i + 2) + '：担当=' + row[personIdx2] + ' 売上=' + row[salesIdx2]);
      }
    });
    Logger.log(found.length ? found.join('\n') : '該当行なし');
  } catch (e) {
    Logger.log('ステップ4エラー：' + e.message);
  }
}

/**
 * 2026年8月分について、待機内訳・拠点売上の実測値と突き合わせる検証関数。
 * 実績DBには書き込まず、稼働一覧ファイルを直接読んで比較する。
 *
 * 検証結果は「エラー」（待機の不整合・キー重複・目標列の残存など、構造的に
 * 起きてはいけないもの）と「情報」（個人合計と拠点の差額。実績DBの行だけを
 * 集計しており担当マスタは一切参照しない）の2段階で最後にまとめて出す。
 * 個人合計と拠点の一致は本来保証される関係ではないため、情報のみで
 * 検証の合否には含めない。
 */
function 検証_2026年8月() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);

  var errors = [];
  var infos = [];

  var expected = {
    waitIts: -2633905,
    waitEng: -760828,
    salesTokyo: 117634508,
    salesOsaka: 39836972,
    salesFukuoka: 6285000
  };

  var driveFolderId = getDriveFolderId(ss);
  var file = findKakudoFile(driveFolderId, 2026, 8);
  if (!file) {
    Logger.log('検証失敗：2026年08月度の稼働一覧ファイルが見つかりません。');
    return;
  }

  var kakudoSS = SpreadsheetApp.openById(file.getId());
  var grid = readKojinSujiGrid(kakudoSS);
  var waitBreakdown = readWaitBreakdown(kakudoSS);

  var col = CONFIG.KOJIN_COL;
  var actual = {
    waitIts: waitBreakdown ? waitBreakdown['its'].cost : null,
    waitEng: waitBreakdown ? waitBreakdown['eng'].cost : null,
    salesTokyo: cellValue(grid, 16, col.SALES_TOTAL),
    salesOsaka: cellValue(grid, 26, col.SALES_TOTAL),
    salesFukuoka: cellValue(grid, 34, col.SALES_TOTAL)
  };

  var lines = [];
  Object.keys(expected).forEach(function (key) {
    var ok = expected[key] === actual[key];
    if (!ok) {
      errors.push('2026年8月ソース突合NG：' + key + '：期待値=' + expected[key] + ' 実測値=' + actual[key]);
    }
    lines.push((ok ? 'OK  ' : 'NG  ') + key + '：期待値=' + expected[key] + ' 実測値=' + actual[key]);
  });

  Logger.log('検証_2026年8月 ソース突合結果（' + (errors.length === 0 ? '全て一致' : '不一致あり') + '）\n' + lines.join('\n'));

  errors = errors.concat(checkWaitBreakdownMatchesLocation(ss));
  errors = errors.concat(checkNoTargetColumnsInResultDb(ss));
  errors = errors.concat(checkAllActiveStaffHavePersonRecords(ss));

  var dup = findResultDbDuplicateGroups(ss);
  if (dup.excessRowCount > 0) {
    errors.push('キー重複あり：' + dup.excessRowCount + '件（' + dup.duplicateKeys.join(', ') + '）');
  }

  infos = infos.concat(checkPersonSumMatchesLocation(ss));

  Logger.log('=== 検証_2026年8月 総合結果 ===');
  Logger.log('エラー（構造的な不整合）：' + (errors.length ? errors.length + '件\n' + errors.join('\n') : 'なし'));
  Logger.log('情報（個人合計と拠点の差額。検証の合否には含めない）：' + (infos.length ? infos.length + '件\n' + infos.join('\n') : 'なし'));
}

/**
 * 実績DBに登場する各月について、担当マスタ上その月時点で在籍している担当の
 * 個人レコード（区分=個人）が実績DBに存在するかを検証する。
 * 「対象月に含まれるはずの担当の行が丸ごと生成されていない」状態
 * （v2.3以前の determineTargetMonths の不具合のような、対象月自体から
 * 漏れて何も処理されないケース）を検知するためのもので、構造的に
 * 起きてはいけない欠落のためエラー扱いにする。
 * @return {Array<string>} 欠落しているエラーメッセージ
 */
function checkAllActiveStaffHavePersonRecords(ss) {
  Logger.log('=== 検証：在籍中の担当の個人レコードが実績DBに存在するか ===');
  var headers = CONFIG.RESULT_DB_HEADERS;
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('実績DBにデータがありません。');
    return [];
  }

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  var ymIdx = headers.indexOf('年月');
  var kindIdx = headers.indexOf('区分');
  var personIdx = headers.indexOf('担当');

  var monthsInDb = {};
  var personYmSet = {}; // key: 年月|担当（区分=個人のみ）
  rows.forEach(function (row) {
    var ym = normalizeYearMonth(row[ymIdx], ss);
    if (!ym) return;
    monthsInDb[ym] = true;
    if (row[kindIdx] === CONFIG.RECORD_KIND.PERSON) {
      personYmSet[ym + '|' + row[personIdx]] = true;
    }
  });

  var staffMaster = getStaffMaster(ss);
  var errors = [];
  Object.keys(monthsInDb).sort().forEach(function (ym) {
    staffMaster.forEach(function (person) {
      if (!isStaffActiveForYm(person, ym)) return;
      var key = ym + '|' + person.name;
      if (!personYmSet[key]) {
        errors.push(
          ym + '：担当「' + person.name + '」の個人レコードが実績DBに存在しません' +
          '（在籍終了年月=' + (person.endYm || '空欄') + '）'
        );
      }
    });
  });

  Logger.log(errors.length ? errors.join('\n') : 'すべて存在');
  return errors;
}

/**
 * 実績DB全体で、月・拠点ごとに「個人の売上合計」と「拠点の売上」が一致するかを検証する。
 * 集計は実績DBに実在する `区分=個人` の行のみを対象とし、担当マスタは一切参照しない
 * （在籍終了済みの担当の行も、実績DBに存在すればそのまま合計に含まれる）。
 * 「個人合計＝拠点」は本来保証される関係ではないため、不一致は情報として扱い
 * 検証の合否には含めない。誰が漏れているか判別できるよう内訳も返す。
 * 実績DBには書き込まない。
 * @return {Array<string>} 不一致の情報メッセージ（内訳つき）
 */
function checkPersonSumMatchesLocation(ss) {
  Logger.log('=== 情報：個人の売上合計 vs 拠点の売上（実績DBの行のみで集計） ===');
  var headers = CONFIG.RESULT_DB_HEADERS;
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('実績DBにデータがありません。');
    return [];
  }

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  var ymIdx = headers.indexOf('年月');
  var kindIdx = headers.indexOf('区分');
  var locIdx = headers.indexOf('拠点');
  var personIdx = headers.indexOf('担当');
  var salesIdx = headers.indexOf('売上');

  var personSum = {};    // key: 年月|拠点
  var personDetail = {}; // key: 年月|拠点 -> ['担当名=売上', ...]
  var locationSales = {}; // key: 年月|拠点

  rows.forEach(function (row) {
    var ym = normalizeYearMonth(row[ymIdx], ss);
    if (!ym) return;
    var key = ym + '|' + row[locIdx];
    if (row[kindIdx] === CONFIG.RECORD_KIND.PERSON) {
      var sales = Number(row[salesIdx]) || 0;
      personSum[key] = (personSum[key] || 0) + sales;
      if (!personDetail[key]) personDetail[key] = [];
      personDetail[key].push(row[personIdx] + '=' + sales);
    } else if (row[kindIdx] === CONFIG.RECORD_KIND.LOCATION) {
      locationSales[key] = Number(row[salesIdx]) || 0;
    }
  });

  var infos = [];
  Object.keys(locationSales).sort().forEach(function (key) {
    var parts = key.split('|');
    var sum = personSum[key] || 0;
    var loc = locationSales[key];
    if (sum !== loc) {
      var detail = (personDetail[key] || []).join(', ') || '（個人レコードなし）';
      infos.push(
        parts[0] + '　' + parts[1] + '：個人合計=' + sum + ' 拠点=' + loc + ' 差額=' + (sum - loc) +
        '\n    内訳：' + detail
      );
    }
  });

  Logger.log(infos.length ? infos.join('\n') : '差額なし');
  return infos;
}

/**
 * 実績DB全体で、月ごとに「待機ITS＋待機ENG」と「拠点東京の待機原価」が一致するかを検証する。
 * 実績DBに実在する行のみを対象とし、担当マスタは参照しない。構造的に一致すべき値のため、
 * 不一致はエラー扱い。実績DBには書き込まない。
 * @return {Array<string>} 不一致のエラーメッセージ
 */
function checkWaitBreakdownMatchesLocation(ss) {
  Logger.log('=== 検証：待機ITS＋ENG vs 拠点東京の待機原価 ===');
  var headers = CONFIG.RESULT_DB_HEADERS;
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('実績DBにデータがありません。');
    return [];
  }

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  var ymIdx = headers.indexOf('年月');
  var kindIdx = headers.indexOf('区分');
  var locIdx = headers.indexOf('拠点');
  var waitProfitIdx = headers.indexOf('待機原価');

  var waitSum = {};        // key: 年月
  var locationWaitProfit = {}; // key: 年月

  rows.forEach(function (row) {
    var ym = normalizeYearMonth(row[ymIdx], ss);
    if (!ym || row[locIdx] !== CONFIG.WAIT_LOCATION) return;
    if (row[kindIdx] === CONFIG.RECORD_KIND.WAITING) {
      waitSum[ym] = (waitSum[ym] || 0) + (Number(row[waitProfitIdx]) || 0);
    } else if (row[kindIdx] === CONFIG.RECORD_KIND.LOCATION) {
      locationWaitProfit[ym] = Number(row[waitProfitIdx]) || 0;
    }
  });

  var errors = [];
  Object.keys(locationWaitProfit).sort().forEach(function (ym) {
    var sum = waitSum[ym] || 0;
    var loc = locationWaitProfit[ym];
    if (sum !== loc) {
      errors.push(ym + '：待機ITS+ENG=' + sum + ' 拠点東京待機原価=' + loc + ' 差額=' + (sum - loc));
    }
  });

  Logger.log(errors.length ? errors.join('\n') : 'すべて一致');
  return errors;
}

/**
 * 実績DBに「目標売上」「目標粗利」列が残っていないことを検証する（v2.1で目標DBへ分離済みのはず）。
 * @return {Array<string>} 残存している場合のエラーメッセージ（1件のみ）
 */
function checkNoTargetColumnsInResultDb(ss) {
  Logger.log('=== 検証：実績DBに目標列が残っていないか ===');
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet) {
    Logger.log('実績DBシートが見つかりません。');
    return [];
  }
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    Logger.log('実績DBにヘッダがありません。');
    return [];
  }
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var remaining = CONFIG.RESULT_DB_REMOVED_HEADERS.filter(function (h) {
    return headerRow.indexOf(h) !== -1;
  });
  Logger.log(remaining.length ? 'NG：残存列＝' + remaining.join(', ') : 'OK：目標列は残っていません');
  return remaining.length ? ['実績DBに目標列が残存：' + remaining.join(', ')] : [];
}
