/**
 * ダッシュボードシート（数式ベースの表示層）の生成・検証。
 * 実績DB・目標DB・担当マスタへは一切書き込まない（読むのは担当マスタのみ、
 * 実績DB・目標DBは Google スプレッドシートの数式が読む。GAS からは読まない）。
 * 書き込み先は Store.gs の ensureDashboardSheet / writeDashboardSheet が触る
 * 「ダッシュボード」シートのみ。既存の転記ロジック（Main.gs / Source.gs）は使うが変更しない。
 *
 * 出自が異なる特殊な算出（セルメモにも同じ内容を記載）：
 * - 東京ITS・東京ENG ブロックの BP数：セクション区分・待機区分にBP数が無いため、
 *   担当マスタの「セクション」で絞った個人のBP数合計（個人ベース）で算出する。
 * - 東京拠点の待機原価：拠点区分・待機区分どちらの集計でも同値になるが、拠点区分の
 *   待機原価列に統一する（大阪・福岡と同じ式にするため）。
 */

var DASH_LABEL_COL = 1;
var DASH_NUM_COLS = 16; // A:label, B..M:4月〜3月(12), N:上期計, O:下期計, P:年度計
var DASH_MONTH_START_COL = 2;
var DASH_H1_COL = 14;
var DASH_H2_COL = 15;
var DASH_YEAR_COL = 16;

var DASH_METRIC_ORDER = [
  'salesTarget', 'salesActual', 'salesDiff', 'salesRate',
  'profitTarget', 'profitActual', 'profitRate',
  'activeHeadcount', 'waitHeadcount', 'waitCost', 'bpCount'
];
var DASH_METRIC_LABEL = {
  salesTarget: '売上 目標', salesActual: '売上 実績', salesDiff: '差異', salesRate: '達成率',
  profitTarget: '粗利(待機込) 目標', profitActual: '粗利(待機込) 実績', profitRate: '粗利率',
  activeHeadcount: '実稼働人数', waitHeadcount: '待機人数', waitCost: '待機原価', bpCount: 'BP数'
};
var DASH_METRIC_FORMAT = {
  salesTarget: 'money', salesActual: 'money', salesDiff: 'money', salesRate: 'rate',
  profitTarget: 'money', profitActual: 'money', profitRate: 'rate',
  activeHeadcount: 'count1', waitHeadcount: 'count1', waitCost: 'money', bpCount: 'count0'
};

var DASH_PERSON_METRIC_ORDER = ['salesTarget', 'salesActual', 'salesDiff', 'salesRate', 'profitActual', 'headcount', 'bpCount'];
var DASH_PERSON_METRIC_LABEL = {
  salesTarget: '売上 目標', salesActual: '売上 実績', salesDiff: '差異', salesRate: '達成率',
  profitActual: '粗利(待機前)', headcount: '稼働人数', bpCount: 'BP数'
};
var DASH_PERSON_METRIC_FORMAT = {
  salesTarget: 'money', salesActual: 'money', salesDiff: 'money', salesRate: 'rate',
  profitActual: 'money', headcount: 'count1', bpCount: 'count0'
};

function dashColLetter(col) {
  return String.fromCharCode(64 + col);
}

function dashA1(row, col) {
  return dashColLetter(col) + row;
}

function dashRdbColLetter(headerName) {
  var idx = CONFIG.RESULT_DB_HEADERS.indexOf(headerName);
  if (idx === -1) throw new Error('実績DBヘッダに存在しない列名です：' + headerName);
  return dashColLetter(idx + 1);
}

function dashTdbColLetter(headerName) {
  var idx = CONFIG.TARGET_DB_HEADERS.indexOf(headerName);
  if (idx === -1) throw new Error('目標DBヘッダに存在しない列名です：' + headerName);
  return dashColLetter(idx + 1);
}

function dashRdbRange(headerName) {
  var c = dashRdbColLetter(headerName);
  return "'" + CONFIG.SHEET_NAMES.RESULT_DB + "'!$" + c + ":$" + c;
}

function dashTdbRange(headerName) {
  var c = dashTdbColLetter(headerName);
  return "'" + CONFIG.SHEET_NAMES.TARGET_DB + "'!$" + c + ":$" + c;
}

/**
 * 実績DBに対する SUMIFS を組み立てる。criteria は絞り込みたい列名だけを渡す
 * （区分だけで一意になる集計では拠点・セクション・担当を渡さなくてよい）。
 */
function dashRdbSumifs(valueCol, criteria, ymRef) {
  var parts = [dashRdbRange(valueCol), dashRdbRange('年月'), ymRef];
  Object.keys(criteria).forEach(function (k) {
    parts.push(dashRdbRange(k));
    parts.push('"' + criteria[k] + '"');
  });
  return 'SUMIFS(' + parts.join(',') + ')';
}

function dashTdbCriteriaParts(criteria, ymRef) {
  var parts = [dashTdbRange('年月'), ymRef];
  Object.keys(criteria).forEach(function (k) {
    parts.push(dashTdbRange(k));
    parts.push('"' + criteria[k] + '"');
  });
  return parts;
}

/**
 * 目標DBの該当キー（年月＋区分＋拠点＋セクション＋担当の完全一致）を検索し、
 * 存在しなければ空文字を返す数式を組み立てる（0や0%を出さないため）。
 */
function dashTdbLookup(valueCol, criteria, ymRef) {
  var critStr = dashTdbCriteriaParts(criteria, ymRef).join(',');
  return 'IF(COUNTIFS(' + critStr + ')=0,"",SUMIFS(' + dashTdbRange(valueCol) + ',' + critStr + '))';
}

/**
 * 拠点の目標値を2段で解決する。
 * 1) 拠点キー（区分=拠点）が目標DBにあればその値。
 * 2) なければ配下セクション（東京ならITS/ENG）の目標を全て満たす場合のみ合算する。
 *    配下セクションが一部でも欠けている場合は空欄にする（部分合計を見せない）。
 * 配下セクションが無い拠点（大阪・福岡）は1)のみ。
 */
function dashLocationTargetFormula(valueCol, loc, subSections, ymRef) {
  var directCrit = dashTdbCriteriaParts({ 区分: '拠点', 拠点: loc, セクション: '', 担当: '' }, ymRef);
  var directCount = 'COUNTIFS(' + directCrit.join(',') + ')';
  var directSum = 'SUMIFS(' + dashTdbRange(valueCol) + ',' + directCrit.join(',') + ')';

  if (!subSections || subSections.length === 0) {
    return 'IF(' + directCount + '=0,"",' + directSum + ')';
  }

  var subCriteriaList = subSections.map(function (s) {
    return dashTdbCriteriaParts({ 区分: 'セクション', 拠点: loc, セクション: s, 担当: '' }, ymRef);
  });
  var subCounts = subCriteriaList.map(function (crit) { return 'COUNTIFS(' + crit.join(',') + ')'; });
  var subSums = subCriteriaList.map(function (crit) { return 'SUMIFS(' + dashTdbRange(valueCol) + ',' + crit.join(',') + ')'; });
  var allSubsExist = subCounts.map(function (c) { return c + '>0'; }).join(',');

  return 'IF(' + directCount + '>0,' + directSum + ',IF(AND(' + allSubsExist + '),' + subSums.join('+') + ',""))';
}

function dashNewRowArray(label) {
  var row = new Array(DASH_NUM_COLS);
  for (var i = 0; i < DASH_NUM_COLS; i++) row[i] = '';
  row[DASH_LABEL_COL - 1] = label;
  return row;
}

function dashFormatForKind(kind) {
  switch (kind) {
    case 'money': return '#,##0';
    case 'rate': return '0.0%';
    case 'count1': return '#,##0.0';
    case 'count0': return '#,##0';
    default: return null;
  }
}

function dashNewFormatArray(kind) {
  var row = new Array(DASH_NUM_COLS);
  for (var i = 0; i < DASH_NUM_COLS; i++) row[i] = null;
  var f = dashFormatForKind(kind);
  for (var c = DASH_MONTH_START_COL; c <= DASH_YEAR_COL; c++) row[c - 1] = f;
  return row;
}

/**
 * 半期計・年度計は「金額・件数」系は月次セルの合計、「達成率・粗利率」系は
 * 半期計・年度計の分子/分母セル同士の比率で算出する（月次%の単純合計にしない）。
 * 金額・件数系は対象月が全て空欄なら 0 ではなく空欄にする（COUNT=0で判定）。
 */
function dashFillSummaryCols(rowArray, row, isRate, numeratorRow, denominatorRow) {
  var b = dashColLetter(DASH_MONTH_START_COL) + row;
  var g = dashColLetter(DASH_MONTH_START_COL + 5) + row;
  var h = dashColLetter(DASH_MONTH_START_COL + 6) + row;
  var m = dashColLetter(DASH_MONTH_START_COL + 11) + row;

  if (!isRate) {
    rowArray[DASH_H1_COL - 1] = '=IF(COUNT(' + b + ':' + g + ')=0,"",SUM(' + b + ':' + g + '))';
    rowArray[DASH_H2_COL - 1] = '=IF(COUNT(' + h + ':' + m + ')=0,"",SUM(' + h + ':' + m + '))';
    rowArray[DASH_YEAR_COL - 1] = '=IF(COUNT(' + b + ':' + m + ')=0,"",SUM(' + b + ':' + m + '))';
    return;
  }

  [DASH_H1_COL, DASH_H2_COL, DASH_YEAR_COL].forEach(function (col) {
    var num = dashA1(numeratorRow, col);
    var den = dashA1(denominatorRow, col);
    rowArray[col - 1] = '=IF(OR(' + den + '="",' + den + '=0),"",' + num + '/' + den + ')';
  });
}

/**
 * 1指標分の行（ラベル・月次12列・半期/年度3列）を values/numberFormats に書き込む。
 * monthFormulas は '=' なしの数式文字列を12個（4月〜3月の順）。値が null の列は空欄のまま。
 */
function dashWriteMetricRow(values, numberFormats, row, label, monthFormulas, formatKind, rateRefs) {
  var arr = dashNewRowArray(label);
  for (var i = 0; i < 12; i++) {
    var f = monthFormulas[i];
    if (f !== null && f !== undefined) arr[DASH_MONTH_START_COL + i - 1] = '=' + f;
  }
  dashFillSummaryCols(arr, row, formatKind === 'rate', rateRefs ? rateRefs.numeratorRow : null, rateRefs ? rateRefs.denominatorRow : null);
  values[row - 1] = arr;
  numberFormats[row - 1] = dashNewFormatArray(formatKind);
}

function dashWriteLabelRow(values, numberFormats, row, label) {
  values[row - 1] = dashNewRowArray(label);
  numberFormats[row - 1] = dashNewFormatArray(null);
}

/**
 * 部門ブロック（全社／東京／大阪／福岡／東京ITS／東京ENG）を1つ分書き込む。
 * @param {Object} ctx {values, numberFormats, notes, months, title, metricStart, kind, location, tokyoMetricStart, engMetricStart}
 * kind: 'LOCATION' | 'ALL' | 'SECTION_ENG' | 'SECTION_ITS'
 */
function dashFillDeptBlock(ctx) {
  var values = ctx.values, numberFormats = ctx.numberFormats, notes = ctx.notes;
  var metricStart = ctx.metricStart;
  dashWriteLabelRow(values, numberFormats, metricStart - 1, ctx.title);

  var rows = {};
  DASH_METRIC_ORDER.forEach(function (key, idx) { rows[key] = metricStart + idx; });

  var monthly = {};
  DASH_METRIC_ORDER.forEach(function (key) { monthly[key] = new Array(12); });

  for (var i = 0; i < 12; i++) {
    var col = DASH_MONTH_START_COL + i;
    var colL = dashColLetter(col);
    var ymRef = colL + '1';
    var targetCellSales = dashA1(rows.salesTarget, col);
    var actualCellSales = dashA1(rows.salesActual, col);
    var targetCellProfit = dashA1(rows.profitTarget, col);
    var actualCellProfit = dashA1(rows.profitActual, col);
    var waitHeadCell = dashA1(rows.waitHeadcount, col);

    var salesTargetF, salesActualF, profitTargetF, profitActualF, headcountRawF, waitHeadF, waitCostF, bpF;

    if (ctx.kind === 'ALL') {
      var locs = ctx.locationRefs; // [{metricStart}, ...] 東京/大阪/福岡
      var sumOfLocs = function (key) {
        return locs.map(function (l) { return dashA1(l.metricStart + DASH_METRIC_ORDER.indexOf(key), col); }).join(',');
      };
      var targetCellsOf = function (key) {
        return locs.map(function (l) { return dashA1(l.metricStart + DASH_METRIC_ORDER.indexOf(key), col); });
      };
      // 全社の目標は東京・大阪・福岡の3つ全てに目標がある場合のみ合算する（1つでも欠けたら空欄）。
      var salesTargetCells = targetCellsOf('salesTarget');
      var profitTargetCells = targetCellsOf('profitTarget');
      salesTargetF = 'IF(AND(' + salesTargetCells.map(function (c) { return c + '<>""'; }).join(',') + '),' + salesTargetCells.join('+') + ',"")';
      profitTargetF = 'IF(AND(' + profitTargetCells.map(function (c) { return c + '<>""'; }).join(',') + '),' + profitTargetCells.join('+') + ',"")';
      salesActualF = 'SUM(' + sumOfLocs('salesActual') + ')';
      profitActualF = 'SUM(' + sumOfLocs('profitActual') + ')';
      headcountRawF = null; // 全社の実稼働・待機は各拠点の実稼働・待機セルをそのまま合算する
      waitHeadF = 'SUM(' + sumOfLocs('waitHeadcount') + ')';
      waitCostF = 'SUM(' + sumOfLocs('waitCost') + ')';
      bpF = 'SUM(' + sumOfLocs('bpCount') + ')';
      monthly.activeHeadcount[i] = 'SUM(' + sumOfLocs('activeHeadcount') + ')';
    } else if (ctx.kind === 'LOCATION') {
      var loc = ctx.location;
      var aggKey = { 区分: '拠点', 拠点: loc };
      var subSections = loc === '東京' ? ['ITS', 'ENG'] : [];
      salesTargetF = dashLocationTargetFormula('目標売上', loc, subSections, ymRef);
      salesActualF = dashRdbSumifs('売上', aggKey, ymRef);
      profitTargetF = dashLocationTargetFormula('目標粗利', loc, subSections, ymRef);
      profitActualF = dashRdbSumifs('粗利', aggKey, ymRef); // 拠点区分は待機込
      headcountRawF = dashRdbSumifs('稼働人数', aggKey, ymRef);
      bpF = dashRdbSumifs('BP数', aggKey, ymRef);
      // 待機原価は拠点区分の待機原価列に直接入っている（東京も大阪・福岡と同じ式で取れる。
      // 東京は待機区分ITS+ENGの合計とも一致するが、ここでは拠点区分の値に統一する）。
      waitCostF = 'ABS(' + dashRdbSumifs('待機原価', aggKey, ymRef) + ')';
      if (loc === '東京') {
        waitHeadF = dashRdbSumifs('待機人数', { 区分: '待機', 拠点: '東京' }, ymRef); // ITS+ENGの合計
      } else {
        waitHeadF = headcountRawF + '-' + dashRdbSumifs('稼働人数', { 区分: '個人', 拠点: loc }, ymRef);
      }
      monthly.activeHeadcount[i] = headcountRawF + '-' + waitHeadCell;
    } else if (ctx.kind === 'SECTION_ENG') {
      var engSectionKey = { 区分: 'セクション', 拠点: '東京', セクション: 'ENG' };
      var engFullKey = { 区分: 'セクション', 拠点: '東京', セクション: 'ENG', 担当: '' };
      var engWaitKey = { 区分: '待機', 拠点: '東京', セクション: 'ENG' };
      salesTargetF = dashTdbLookup('目標売上', engFullKey, ymRef);
      salesActualF = dashRdbSumifs('売上', engSectionKey, ymRef);
      profitTargetF = dashTdbLookup('目標粗利', engFullKey, ymRef);
      profitActualF = dashRdbSumifs('粗利', engSectionKey, ymRef) + '+' + dashRdbSumifs('待機原価', engWaitKey, ymRef);
      // ENGはセクション区分＝待機前がそのまま実稼働（待機込人数-待機人数=セクションの素の人数と同値）。
      headcountRawF = dashRdbSumifs('稼働人数', engSectionKey, ymRef);
      waitHeadF = dashRdbSumifs('待機人数', engWaitKey, ymRef);
      waitCostF = 'ABS(' + dashRdbSumifs('待機原価', engWaitKey, ymRef) + ')';
      bpF = dashPersonBpSumFormula(ctx.personNames, '東京', ymRef); // 個人ベース（セクション区分にBP数が無いため）
      monthly.activeHeadcount[i] = headcountRawF;
    } else if (ctx.kind === 'SECTION_ITS') {
      var itsSalesF = dashRdbSumifs('売上', { 区分: '拠点', 拠点: '東京' }, ymRef) + '-' + dashRdbSumifs('売上', { 区分: 'セクション', 拠点: '東京', セクション: 'ENG' }, ymRef);
      var itsFullKey = { 区分: 'セクション', 拠点: '東京', セクション: 'ITS', 担当: '' };
      var itsWaitKey = { 区分: '待機', 拠点: '東京', セクション: 'ITS' };
      var tokyoProfitCell = dashA1(ctx.tokyoMetricStart + DASH_METRIC_ORDER.indexOf('profitActual'), col);
      var engProfitCell = dashA1(ctx.engMetricStart + DASH_METRIC_ORDER.indexOf('profitActual'), col);
      var tokyoHeadRawF = dashRdbSumifs('稼働人数', { 区分: '拠点', 拠点: '東京' }, ymRef);
      // ENG人数込（ENGの実稼働+ENGの待機）を東京拠点人数から引いた中間値＝ITS人数込。
      // これは待機込みの中間値であり、そのままでは実稼働人数として表示しない
      // （下の monthly.activeHeadcount で ITS自身の待機人数を更に引いてから表示する）。
      var engInclCell = '(' + dashA1(ctx.engMetricStart + DASH_METRIC_ORDER.indexOf('activeHeadcount'), col) + '+' + dashA1(ctx.engMetricStart + DASH_METRIC_ORDER.indexOf('waitHeadcount'), col) + ')';

      salesTargetF = dashTdbLookup('目標売上', itsFullKey, ymRef);
      salesActualF = itsSalesF;
      profitTargetF = dashTdbLookup('目標粗利', itsFullKey, ymRef);
      profitActualF = tokyoProfitCell + '-' + engProfitCell; // ITS粗利込 = 東京拠点粗利 - ENG粗利込
      headcountRawF = tokyoHeadRawF + '-' + engInclCell; // ITS人数込（中間値） = 東京拠点人数 - ENG人数込
      waitHeadF = dashRdbSumifs('待機人数', itsWaitKey, ymRef);
      waitCostF = 'ABS(' + dashRdbSumifs('待機原価', itsWaitKey, ymRef) + ')';
      bpF = dashPersonBpSumFormula(ctx.personNames, '東京', ymRef); // 個人ベース（セクション区分にBP数が無いため）
      monthly.activeHeadcount[i] = headcountRawF + '-' + waitHeadCell; // ITS実稼働 = ITS人数込(中間値) - ITS待機
    }

    monthly.salesTarget[i] = salesTargetF;
    monthly.salesActual[i] = salesActualF;
    monthly.salesDiff[i] = 'IF(' + targetCellSales + '="","",' + actualCellSales + '-' + targetCellSales + ')';
    monthly.salesRate[i] = 'IF(OR(' + targetCellSales + '="",' + targetCellSales + '=0),"",' + actualCellSales + '/' + targetCellSales + ')';
    monthly.profitTarget[i] = profitTargetF;
    monthly.profitActual[i] = profitActualF;
    monthly.profitRate[i] = 'IF(' + actualCellSales + '=0,"",' + actualCellProfit + '/' + actualCellSales + ')';
    monthly.waitHeadcount[i] = waitHeadF;
    monthly.waitCost[i] = waitCostF;
    monthly.bpCount[i] = bpF;
  }

  DASH_METRIC_ORDER.forEach(function (key) {
    var row = rows[key];
    var rateRefs = null;
    if (key === 'salesRate') rateRefs = { numeratorRow: rows.salesActual, denominatorRow: rows.salesTarget };
    if (key === 'profitRate') rateRefs = { numeratorRow: rows.profitActual, denominatorRow: rows.salesActual };
    dashWriteMetricRow(values, numberFormats, row, DASH_METRIC_LABEL[key], monthly[key], DASH_METRIC_FORMAT[key], rateRefs);
  });

  // 待機原価は拠点区分・待機区分いずれも実績DB上は負値で格納されている。
  // この行は ABS() で正の値に変換して表示し、内部計算（粗利込等）では負値のまま加算している。
  notes[rows.waitCost - 1][DASH_LABEL_COL - 1] =
    '実績DB上は待機原価が負値で格納されている。この行は ABS() で正の値に変換して表示している。' +
    '粗利(待機込)などの内部計算では負値のまま加算している。';

  if (ctx.kind === 'SECTION_ENG' || ctx.kind === 'SECTION_ITS') {
    values[rows.bpCount - 1][DASH_LABEL_COL - 1] = 'BP数（個人ベース）';
    notes[rows.bpCount - 1][DASH_LABEL_COL - 1] =
      '個人の主セクションで分類。平川のENG分BPはITS側に含まれる。';
  }

  if (ctx.kind === 'LOCATION' && ctx.location === '東京') {
    notes[rows.salesTarget - 1][DASH_LABEL_COL - 1] =
      '拠点キー（区分=拠点、拠点=東京）の目標があればそれを使う。無ければITS・ENGの目標が' +
      '両方揃っている場合のみ合算する（片方だけの部分合計は表示しない）。';
    notes[rows.profitTarget - 1][DASH_LABEL_COL - 1] =
      notes[rows.salesTarget - 1][DASH_LABEL_COL - 1];
  }
  if (ctx.kind === 'ALL') {
    notes[rows.salesTarget - 1][DASH_LABEL_COL - 1] =
      '東京・大阪・福岡の3拠点すべてに目標がある場合のみ合算する。未設定の拠点があるため非表示。';
    notes[rows.profitTarget - 1][DASH_LABEL_COL - 1] =
      notes[rows.salesTarget - 1][DASH_LABEL_COL - 1];
  }
}

/**
 * 拠点=東京・区分=個人のうち、指定した氏名リスト（担当マスタのセクションで絞った人たち）の
 * BP数を合算する数式を組み立てる（セクション区分にBP数が無いため個人ベースで算出する）。
 * 該当する担当がいない場合は空文字の数式（常に空欄）を返す。
 */
function dashPersonBpSumFormula(names, location, ymRef) {
  if (!names || names.length === 0) return '""';
  return names.map(function (name) {
    return dashRdbSumifs('BP数', { 区分: '個人', 拠点: location, 担当: name }, ymRef);
  }).join('+');
}

function dashGroupKey(person) {
  if (person.location === '東京' && person.section === 'ITS') return '東京ITS';
  if (person.location === '東京' && person.section === 'ENG') return '東京ENG';
  if (person.location === '大阪') return '大阪';
  if (person.location === '福岡') return '福岡';
  return null;
}

/**
 * 個人ブロック1人分（見出し行＋7指標行）を書き込む。startRow から書き始め、消費した行数を返す。
 */
function dashFillPersonBlock(ctx, startRow, person, location) {
  var values = ctx.values, numberFormats = ctx.numberFormats;
  dashWriteLabelRow(values, numberFormats, startRow, person.name);

  var rows = {};
  DASH_PERSON_METRIC_ORDER.forEach(function (key, idx) { rows[key] = startRow + 1 + idx; });

  var monthly = {};
  DASH_PERSON_METRIC_ORDER.forEach(function (key) { monthly[key] = new Array(12); });

  var fullKey = { 区分: '個人', 拠点: location, セクション: '', 担当: person.name };

  for (var i = 0; i < 12; i++) {
    var col = DASH_MONTH_START_COL + i;
    var colL = dashColLetter(col);
    var ymRef = colL + '1';
    var targetCell = dashA1(rows.salesTarget, col);
    var actualCell = dashA1(rows.salesActual, col);

    var raw = {
      salesTarget: dashTdbLookup('目標売上', fullKey, ymRef),
      salesActual: dashRdbSumifs('売上', fullKey, ymRef),
      profitActual: dashRdbSumifs('粗利', fullKey, ymRef),
      headcount: dashRdbSumifs('稼働人数', fullKey, ymRef),
      bpCount: dashRdbSumifs('BP数', fullKey, ymRef)
    };
    raw.salesDiff = 'IF(' + targetCell + '="","",' + actualCell + '-' + targetCell + ')';
    raw.salesRate = 'IF(OR(' + targetCell + '="",' + targetCell + '=0),"",' + actualCell + '/' + targetCell + ')';

    var gated = {};
    Object.keys(raw).forEach(function (key) {
      gated[key] = person.endYm ? 'IF(' + ymRef + '>"' + person.endYm + '","",' + raw[key] + ')' : raw[key];
    });

    DASH_PERSON_METRIC_ORDER.forEach(function (key) { monthly[key][i] = gated[key]; });
  }

  DASH_PERSON_METRIC_ORDER.forEach(function (key) {
    var row = rows[key];
    var rateRefs = key === 'salesRate' ? { numeratorRow: rows.salesActual, denominatorRow: rows.salesTarget } : null;
    dashWriteMetricRow(values, numberFormats, row, DASH_PERSON_METRIC_LABEL[key], monthly[key], DASH_PERSON_METRIC_FORMAT[key], rateRefs);
  });

  return 1 + DASH_PERSON_METRIC_ORDER.length; // 見出し1行 + 指標7行
}

/**
 * ダッシュボードシートの表示計画（値・数式・書式・非表示行）を組み立てる。
 * 実績DB・目標DBは読まない（数式が読む）。読むのは担当マスタのみ（getStaffMaster）。
 */
function buildDashboardPlan(ss, staffMaster) {
  var months = getFiscalYearMonths(new Date());

  var HEADER_ROWS = 3;
  var ALL_START = HEADER_ROWS + 1;          // 4
  var ALL_METRIC_START = ALL_START + 1;     // 5
  var TOKYO_START = ALL_METRIC_START + 11 + 1;   // 17
  var TOKYO_METRIC_START = TOKYO_START + 1;      // 18
  var ITS_START = TOKYO_METRIC_START + 11 + 1;   // 30
  var ITS_METRIC_START = ITS_START + 1;          // 31
  var ENG_START = ITS_METRIC_START + 11 + 1;     // 43
  var ENG_METRIC_START = ENG_START + 1;          // 44
  var OSAKA_START = ENG_METRIC_START + 11 + 1;   // 56
  var OSAKA_METRIC_START = OSAKA_START + 1;      // 57
  var FUKUOKA_START = OSAKA_METRIC_START + 11 + 1; // 69
  var FUKUOKA_METRIC_START = FUKUOKA_START + 1;    // 70
  var PERSON_TITLE_ROW = FUKUOKA_METRIC_START + 11 + 1; // 82
  var PERSON_NOTE_ROW = PERSON_TITLE_ROW + 1;           // 83
  var PERSON_GROUPS_START = PERSON_NOTE_ROW + 2;        // 85（1行空けて開始）

  var values = [];
  var numberFormats = [];
  var notes = [];
  for (var r = 1; r < PERSON_GROUPS_START; r++) {
    values[r - 1] = dashNewRowArray('');
    numberFormats[r - 1] = dashNewFormatArray(null);
    notes[r - 1] = new Array(DASH_NUM_COLS).fill('');
  }

  // ヘッダ行1: 非表示の年月キー行
  values[0][DASH_LABEL_COL - 1] = 'キー（非表示）';
  months.forEach(function (t, i) {
    values[0][DASH_MONTH_START_COL + i - 1] = ymKey(t.year, t.month);
  });
  for (var c = DASH_MONTH_START_COL; c <= DASH_YEAR_COL; c++) numberFormats[0][c - 1] = '@';

  // ヘッダ行2: 月表示
  values[1][DASH_LABEL_COL - 1] = '';
  months.forEach(function (t, i) {
    values[1][DASH_MONTH_START_COL + i - 1] = t.month + '月';
  });
  values[1][DASH_H1_COL - 1] = '上期計';
  values[1][DASH_H2_COL - 1] = '下期計';
  values[1][DASH_YEAR_COL - 1] = '年度計';

  // ヘッダ行3: 状態（拠点東京）
  values[2][DASH_LABEL_COL - 1] = '状態（東京）';
  for (var i = 0; i < 12; i++) {
    var col = DASH_MONTH_START_COL + i;
    var ymRef = dashColLetter(col) + '1';
    values[2][col - 1] = '=IFERROR(INDEX(FILTER(' + dashRdbRange('状態') + ',' + dashRdbRange('年月') + '=' + ymRef + ',' +
      dashRdbRange('区分') + '="拠点",' + dashRdbRange('拠点') + '="東京"),1),"")';
  }

  var baseCtx = { values: values, numberFormats: numberFormats, notes: notes };

  var itsNames = staffMaster.filter(function (p) { return dashGroupKey(p) === '東京ITS'; }).map(function (p) { return p.name; });
  var engNames = staffMaster.filter(function (p) { return dashGroupKey(p) === '東京ENG'; }).map(function (p) { return p.name; });

  dashFillDeptBlock(Object.assign({}, baseCtx, {
    title: '東京', kind: 'LOCATION', location: '東京', metricStart: TOKYO_METRIC_START
  }));
  dashFillDeptBlock(Object.assign({}, baseCtx, {
    title: '大阪', kind: 'LOCATION', location: '大阪', metricStart: OSAKA_METRIC_START
  }));
  dashFillDeptBlock(Object.assign({}, baseCtx, {
    title: '福岡', kind: 'LOCATION', location: '福岡', metricStart: FUKUOKA_METRIC_START
  }));
  dashFillDeptBlock(Object.assign({}, baseCtx, {
    title: '┗ENG', kind: 'SECTION_ENG', metricStart: ENG_METRIC_START, personNames: engNames
  }));
  dashFillDeptBlock(Object.assign({}, baseCtx, {
    title: '┗ITS', kind: 'SECTION_ITS', metricStart: ITS_METRIC_START,
    tokyoMetricStart: TOKYO_METRIC_START, engMetricStart: ENG_METRIC_START, personNames: itsNames
  }));
  dashFillDeptBlock(Object.assign({}, baseCtx, {
    title: '全社', kind: 'ALL', metricStart: ALL_METRIC_START,
    locationRefs: [{ metricStart: TOKYO_METRIC_START }, { metricStart: OSAKA_METRIC_START }, { metricStart: FUKUOKA_METRIC_START }]
  }));

  dashWriteLabelRow(values, numberFormats, PERSON_TITLE_ROW, '個人（セクション別）');
  dashWriteLabelRow(values, numberFormats, PERSON_NOTE_ROW, '※個人は主セクションで分類。セクション合計とは一致しない');

  var groups = [
    { label: '東京ITS', location: '東京', section: 'ITS' },
    { label: '東京ENG', location: '東京', section: 'ENG' },
    { label: '大阪', location: '大阪', section: null },
    { label: '福岡', location: '福岡', section: null }
  ];

  var unassigned = [];
  var row = PERSON_GROUPS_START;
  groups.forEach(function (group) {
    var persons = staffMaster.filter(function (p) { return dashGroupKey(p) === group.label; });
    persons.sort(function (a, b) { return a.order - b.order; });

    dashWriteLabelRow(values, numberFormats, row, group.label);
    row += 1;

    persons.forEach(function (person) {
      row += dashFillPersonBlock({ values: values, numberFormats: numberFormats }, row, person, group.location);
      row += 1; // 人と人の間の空行
    });
  });

  staffMaster.forEach(function (p) {
    if (!dashGroupKey(p)) unassigned.push(p.name + '（拠点=' + p.location + ' セクション=' + (p.section || '空欄') + '）');
  });

  var numRows = row - 1;
  for (var rr = 1; rr <= numRows; rr++) {
    if (!values[rr - 1]) values[rr - 1] = dashNewRowArray('');
    if (!numberFormats[rr - 1]) numberFormats[rr - 1] = dashNewFormatArray(null);
    if (!notes[rr - 1]) notes[rr - 1] = new Array(DASH_NUM_COLS).fill('');
  }

  return {
    numRows: numRows,
    numCols: DASH_NUM_COLS,
    values: values,
    numberFormats: numberFormats,
    notes: notes,
    hiddenRows: [1],
    frozenRows: 3,
    frozenColumns: 1,
    unassigned: unassigned
  };
}

/**
 * ダッシュボードシートを再構築する。Menu.gs のハンドラからのみ呼び出される想定。
 * 担当マスタ以外の実データ（実績DB・目標DB）は読まない・書かない
 * （シート上の数式が実績DB・目標DBを読む）。
 */
function rebuildDashboard(ss) {
  requireAdmin(ss);

  migrateStaffMasterAddSectionColumn(ss);
  var staffMaster = getStaffMaster(ss);

  var plan = buildDashboardPlan(ss, staffMaster);
  writeDashboardSheet(ss, plan);

  var message = 'ダッシュボードを再構築しました。';
  if (plan.unassigned.length > 0) {
    message += '\n\n警告：以下の担当は拠点・セクションの組み合わせがどのグループにも一致せず、' +
      '個人ブロックに表示されません。\n' + plan.unassigned.join('\n');
  }
  SpreadsheetApp.getUi().alert(message);
}

/* ==================== 検証_ダッシュボード() ==================== */

function dashGetResultDbRows(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.RESULT_DB);
  if (!sheet || sheet.getLastRow() < 2) return { headers: CONFIG.RESULT_DB_HEADERS, rows: [] };
  var headers = CONFIG.RESULT_DB_HEADERS;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  return { headers: headers, rows: rows };
}

/**
 * b. 拠点粗利 vs（個人粗利合計＋待機原価）。実績DBの行のみを集計し、差異は情報として出す
 *    （補正は入れない）。待機原価は【拠点区分】のレコードから取得する
 *    （待機区分は東京にしか存在しないため、待機区分から取ると大阪・福岡の待機原価が
 *    常にゼロ扱いになり、待機原価の額がそのまま差額として出てしまう不具合があった。
 *    ダッシュボードの数式（修正1）と同じ取得元に統一した）。
 */
function checkLocationProfitVsPersonPlusWait(ss) {
  Logger.log('=== 情報：拠点粗利 vs（個人粗利合計＋待機原価） ===');
  var data = dashGetResultDbRows(ss);
  if (data.rows.length === 0) { Logger.log('実績DBにデータがありません。'); return []; }
  var h = data.headers;
  var ymIdx = h.indexOf('年月'), kindIdx = h.indexOf('区分'), locIdx = h.indexOf('拠点'), profitIdx = h.indexOf('粗利'), waitIdx = h.indexOf('待機原価');

  var personSum = {}, waitSum = {}, locationProfit = {};
  data.rows.forEach(function (row) {
    var ym = normalizeYearMonth(row[ymIdx], ss);
    if (!ym) return;
    var key = ym + '|' + row[locIdx];
    if (row[kindIdx] === CONFIG.RECORD_KIND.PERSON) {
      personSum[key] = (personSum[key] || 0) + (Number(row[profitIdx]) || 0);
    } else if (row[kindIdx] === CONFIG.RECORD_KIND.LOCATION) {
      locationProfit[key] = Number(row[profitIdx]) || 0;
      waitSum[key] = Number(row[waitIdx]) || 0; // 拠点区分の待機原価列（負値）
    }
  });

  var infos = [];
  var tokyoDiffFound = false;
  Object.keys(locationProfit).sort().forEach(function (key) {
    var parts = key.split('|');
    var expected = (personSum[key] || 0) + (waitSum[key] || 0);
    var actual = locationProfit[key];
    if (expected !== actual) {
      infos.push(parts[0] + '　' + parts[1] + '：拠点粗利=' + actual + ' 個人粗利合計+待機原価=' + expected + ' 差額=' + (actual - expected));
      if (parts[1] === '東京') tokyoDiffFound = true;
    }
  });
  if (tokyoDiffFound) {
    infos.push(
      '情報：東京の差額は個人に紐づかない項目（稼働一覧 個人数字 12〜15行目が候補）と推定されるが未特定。' +
      '6月は売上差額 200,000 と同額だけ粗利差額が小さくなっている（-243,510 → -43,510）。'
    );
  }
  Logger.log(infos.length ? infos.join('\n') : '差額なし');
  return infos;
}

/**
 * c. 東京：拠点人数－個人人数合計 が 待機レコードの人数合計と一致するか（構造上一致すべき）。
 */
function checkTokyoHeadcountVsWaitRecords(ss) {
  Logger.log('=== 検証：東京 拠点人数-個人人数合計 vs 待機人数合計 ===');
  var data = dashGetResultDbRows(ss);
  if (data.rows.length === 0) { Logger.log('実績DBにデータがありません。'); return []; }
  var h = data.headers;
  var ymIdx = h.indexOf('年月'), kindIdx = h.indexOf('区分'), locIdx = h.indexOf('拠点'), staffIdx = h.indexOf('稼働人数'), waitStaffIdx = h.indexOf('待機人数');

  var locHead = {}, personHead = {}, waitHead = {};
  data.rows.forEach(function (row) {
    var ym = normalizeYearMonth(row[ymIdx], ss);
    if (!ym || row[locIdx] !== '東京') return;
    if (row[kindIdx] === CONFIG.RECORD_KIND.LOCATION) locHead[ym] = Number(row[staffIdx]) || 0;
    else if (row[kindIdx] === CONFIG.RECORD_KIND.PERSON) personHead[ym] = (personHead[ym] || 0) + (Number(row[staffIdx]) || 0);
    else if (row[kindIdx] === CONFIG.RECORD_KIND.WAITING) waitHead[ym] = (waitHead[ym] || 0) + (Number(row[waitStaffIdx]) || 0);
  });

  var errors = [];
  Object.keys(locHead).sort().forEach(function (ym) {
    var diff = (locHead[ym] || 0) - (personHead[ym] || 0);
    var wait = waitHead[ym] || 0;
    if (diff !== wait) {
      errors.push(ym + '：拠点人数-個人合計=' + diff + ' 待機人数合計=' + wait + ' 差=' + (diff - wait));
    }
  });
  Logger.log(errors.length ? errors.join('\n') : 'すべて一致');
  return errors;
}

/**
 * d. ITS/ENGの実稼働人数・待機人数を独立に再計算し、以下2つの検算条件を確認する
 *    （ダッシュボードの数式は使わず、実績DBの生データから直接算出する）。
 *    - ITS実稼働 + ENG実稼働 = 東京実稼働
 *    - ITS待機   + ENG待機   = 東京待機
 *    ITS人数込（東京拠点人数-ENG人数込）は待機込みの中間値であり、実稼働人数として
 *    そのまま報告してはならない（trapとして併記し、実稼働人数と一致したら異常）。
 */
function checkItsHeadcountFormula(ss) {
  Logger.log('=== 情報：ITS/ENGの実稼働人数・待機人数の再計算 ===');
  var data = dashGetResultDbRows(ss);
  if (data.rows.length === 0) { Logger.log('実績DBにデータがありません。'); return []; }
  var h = data.headers;
  var ymIdx = h.indexOf('年月'), kindIdx = h.indexOf('区分'), locIdx = h.indexOf('拠点'), secIdx = h.indexOf('セクション'), staffIdx = h.indexOf('稼働人数'), waitStaffIdx = h.indexOf('待機人数');

  var tokyoRaw = {}, tokyoWait = {}, engRaw = {}, engWait = {}, itsWait = {};
  data.rows.forEach(function (row) {
    var ym = normalizeYearMonth(row[ymIdx], ss);
    if (!ym || row[locIdx] !== '東京') return;
    if (row[kindIdx] === CONFIG.RECORD_KIND.LOCATION) {
      tokyoRaw[ym] = Number(row[staffIdx]) || 0;
    } else if (row[kindIdx] === CONFIG.RECORD_KIND.SECTION && row[secIdx] === 'ENG') {
      engRaw[ym] = Number(row[staffIdx]) || 0;
    } else if (row[kindIdx] === CONFIG.RECORD_KIND.WAITING) {
      tokyoWait[ym] = (tokyoWait[ym] || 0) + (Number(row[waitStaffIdx]) || 0);
      if (row[secIdx] === 'ENG') engWait[ym] = Number(row[waitStaffIdx]) || 0;
      if (row[secIdx] === 'ITS') itsWait[ym] = Number(row[waitStaffIdx]) || 0;
    }
  });

  var errors = [];
  Object.keys(tokyoRaw).sort().forEach(function (ym) {
    var raw = tokyoRaw[ym];
    var eRaw = engRaw[ym] || 0;
    var eWait = engWait[ym] || 0;
    var iWait = itsWait[ym] || 0;
    var tWait = tokyoWait[ym] || 0;
    var engIncl = eRaw + eWait;
    var itsInclTrap = raw - engIncl; // 待機込みの中間値。実稼働人数として表示してはならない
    var itsActive = itsInclTrap - iWait; // ITS実稼働
    var engActive = eRaw; // ENGはセクション区分＝待機前がそのまま実稼働
    var tokyoActive = raw - tWait;

    Logger.log(
      ym + '：ITS実稼働=' + itsActive + ' ENG実稼働=' + engActive + ' 東京実稼働=' + tokyoActive +
      ' / ITS待機=' + iWait + ' ENG待機=' + eWait + ' 東京待機=' + tWait +
      ' / （参考・表示禁止の中間値）ITS人数込=' + itsInclTrap
    );

    if (itsActive + engActive !== tokyoActive) {
      errors.push(ym + '：ITS実稼働+ENG実稼働(' + (itsActive + engActive) + ') ≠ 東京実稼働(' + tokyoActive + ')');
    }
    if (iWait + eWait !== tWait) {
      errors.push(ym + '：ITS待機+ENG待機(' + (iWait + eWait) + ') ≠ 東京待機(' + tWait + ')');
    }
    if (itsActive === itsInclTrap && iWait !== 0) {
      errors.push(ym + '：ITS実稼働が待機込みの中間値と一致した（要確認）');
    }
  });
  Logger.log(errors.length ? 'エラー：\n' + errors.join('\n') : '検算条件を満たす（不一致なし）');
  return errors;
}

/**
 * ITS・ENGのBP数（個人ベース）が拠点東京のBP数（拠点区分の実績）と一致するかを確認する。
 * 一致しない場合、担当マスタのセクション割り当て漏れ・重複の可能性がある。
 */
function checkItsEngBpCountVsLocation(ss) {
  Logger.log('=== 情報：ITS・ENGのBP数（個人ベース）vs 拠点東京のBP数 ===');
  var data = dashGetResultDbRows(ss);
  if (data.rows.length === 0) { Logger.log('実績DBにデータがありません。'); return []; }
  var h = data.headers;
  var ymIdx = h.indexOf('年月'), kindIdx = h.indexOf('区分'), locIdx = h.indexOf('拠点'), personIdx = h.indexOf('担当'), bpIdx = h.indexOf('BP数');

  var staffMaster = getStaffMaster(ss);
  var itsNames = {}, engNames = {};
  staffMaster.forEach(function (p) {
    var key = dashGroupKey(p);
    if (key === '東京ITS') itsNames[p.name] = true;
    else if (key === '東京ENG') engNames[p.name] = true;
  });

  var tokyoBp = {}, itsBp = {}, engBp = {};
  data.rows.forEach(function (row) {
    var ym = normalizeYearMonth(row[ymIdx], ss);
    if (!ym || row[locIdx] !== '東京') return;
    var bp = Number(row[bpIdx]) || 0;
    if (row[kindIdx] === CONFIG.RECORD_KIND.LOCATION) {
      tokyoBp[ym] = bp;
    } else if (row[kindIdx] === CONFIG.RECORD_KIND.PERSON) {
      var name = row[personIdx];
      if (itsNames[name]) itsBp[ym] = (itsBp[ym] || 0) + bp;
      else if (engNames[name]) engBp[ym] = (engBp[ym] || 0) + bp;
    }
  });

  var infos = [];
  Object.keys(tokyoBp).sort().forEach(function (ym) {
    var its = itsBp[ym] || 0;
    var eng = engBp[ym] || 0;
    var loc = tokyoBp[ym];
    Logger.log(ym + '：ITS BP数=' + its + ' ENG BP数=' + eng + ' 東京拠点BP数=' + loc);
    if (its + eng !== loc) {
      infos.push(ym + '：ITS+ENG BP数(' + (its + eng) + ') ≠ 東京拠点BP数(' + loc + ')。担当マスタのセクション割り当てを確認');
    }
  });
  Logger.log(infos.length ? infos.join('\n') : '差異なし');
  return infos;
}

/**
 * e. 目標DBの各キー（年月＋区分＋拠点＋セクション＋担当）が実績DBの distinct キーに存在するか。
 */
function checkTargetDbKeysExistInResultDb(ss) {
  Logger.log('=== 情報：目標DBのキーが実績DBに存在するか ===');
  var targetSheet = ss.getSheetByName(CONFIG.SHEET_NAMES.TARGET_DB);
  if (!targetSheet || targetSheet.getLastRow() < 3) { Logger.log('目標DBにデータ行がありません。'); return []; }

  var tHeaders = CONFIG.TARGET_DB_HEADERS;
  var tRows = targetSheet.getRange(3, 1, targetSheet.getLastRow() - 2, tHeaders.length).getValues();

  var resultKeys = {};
  var data = dashGetResultDbRows(ss);
  data.rows.forEach(function (row) {
    var record = {};
    data.headers.forEach(function (hName, c) { record[hName] = row[c]; });
    resultKeys[buildResultDbKey(record, ss)] = true;
  });

  var excludedCount = 0;
  var missing = [];
  tRows.forEach(function (row) {
    if (!row[0] && !row[1]) return; // 完全な空行はスキップ
    var record = {};
    tHeaders.forEach(function (hName, c) { record[hName] = row[c]; });

    // ITSは実績DBが持たない算出値（東京拠点-ENGセクション）のため、目標DB側にのみ
    // このキーが存在するのは正常。エラーではなく除外して件数だけ報告する。
    if (record['区分'] === 'セクション' && record['拠点'] === '東京' && record['セクション'] === 'ITS') {
      excludedCount++;
      return;
    }

    var key = CONFIG.RESULT_DB_KEY_COLS.map(function (col) {
      return col === '年月' ? normalizeYearMonth(record[col], ss) : record[col];
    }).join('');
    if (!resultKeys[key]) {
      missing.push('年月=' + record['年月'] + ' 区分=' + record['区分'] + ' 拠点=' + record['拠点'] + ' セクション=' + record['セクション'] + ' 担当=' + record['担当']);
    }
  });
  if (excludedCount > 0) {
    Logger.log('既知の例外として除外：区分=セクション 拠点=東京 セクション=ITS （' + excludedCount + '件。ITSは実績DBに持たない算出値のため目標側のみに存在してよい）');
  }
  Logger.log(missing.length ? missing.join('\n') : 'すべて実績DBに存在');
  return missing;
}

/**
 * f. 全社=東京+大阪+福岡 で漏れがないか。実績DBの拠点区分に東京・大阪・福岡以外の
 *    拠点名が存在すると、ダッシュボードの「全社」はそれを合算しないまま漏れる。
 */
function checkLocationCompleteness(ss) {
  Logger.log('=== 検証：拠点区分の拠点名が東京・大阪・福岡のみか ===');
  var data = dashGetResultDbRows(ss);
  if (data.rows.length === 0) { Logger.log('実績DBにデータがありません。'); return []; }
  var h = data.headers;
  var kindIdx = h.indexOf('区分'), locIdx = h.indexOf('拠点');
  var known = ['東京', '大阪', '福岡'];
  var others = {};
  data.rows.forEach(function (row) {
    if (row[kindIdx] === CONFIG.RECORD_KIND.LOCATION && known.indexOf(row[locIdx]) === -1) {
      others[row[locIdx]] = true;
    }
  });
  var errors = Object.keys(others).map(function (loc) {
    return '拠点区分に未知の拠点名「' + loc + '」が存在（ダッシュボードの全社集計に含まれない）';
  });
  Logger.log(errors.length ? errors.join('\n') : '東京・大阪・福岡のみ');
  return errors;
}

/**
 * ダッシュボードの集計規約が実データと整合しているかを確認する検証関数。read-only。
 * 実績DB・目標DB・担当マスタへは一切書き込まない。
 */
function 検証_ダッシュボード() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);

  var infos = [];
  var errors = [];

  infos = infos.concat(checkPersonSumMatchesLocation(ss)); // a.（Main.gsの既存検証を再利用）
  infos = infos.concat(checkLocationProfitVsPersonPlusWait(ss)); // b.
  errors = errors.concat(checkTokyoHeadcountVsWaitRecords(ss)); // c.
  errors = errors.concat(checkItsHeadcountFormula(ss)); // d.（ITS/ENGの実稼働・待機の検算を含む）
  infos = infos.concat(checkTargetDbKeysExistInResultDb(ss)); // e.
  errors = errors.concat(checkLocationCompleteness(ss)); // f.
  infos = infos.concat(checkItsEngBpCountVsLocation(ss)); // ITS/ENGのBP数（個人ベース）検算

  Logger.log('=== 検証_ダッシュボード 総合結果 ===');
  Logger.log('エラー：' + (errors.length ? errors.length + '件\n' + errors.join('\n') : 'なし'));
  Logger.log('情報：' + (infos.length ? infos.length + '件\n' + infos.join('\n') : 'なし'));
}
