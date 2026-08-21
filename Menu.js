/**
 * 管理者判定とカスタムメニュー。
 * メニュー表示・実行のいずれも管理者以外はブロックする。
 */

function isAdminUser(ss) {
  var currentEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!currentEmail) return false;
  var adminEmails = getAdminEmails(ss);
  return adminEmails.indexOf(currentEmail) !== -1;
}

/**
 * 管理者でなければ例外を投げる。直接実行（エディタからの実行等）にも効かせる。
 */
function requireAdmin(ss) {
  if (!isAdminUser(ss)) {
    throw new Error('この操作は管理者のみ実行できます。');
  }
}

function onOpen() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!isAdminUser(ss)) return;

  SpreadsheetApp.getUi()
    .createMenu('稼働データ転記')
    .addItem('実績を転記（通常）', 'menuTranscribeNormal')
    .addItem('実績を転記（確定済みも強制上書き）', 'menuTranscribeForce')
    .addItem('転記ログを開く', 'menuOpenLog')
    .addItem('ダッシュボードを再構築', 'menuRebuildDashboard')
    .addSeparator()
    .addItem('目標管理シートへ書き戻し（ドライラン）', 'menuWriteBackDryRun')
    .addItem('目標管理シートへ書き戻し（実行）', 'menuWriteBackExecute')
    .addToUi();
}

function menuTranscribeNormal() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);
  runTranscribe(ss, false);
}

function menuTranscribeForce() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);

  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    '確定済みの月も含めて強制的に上書きします。よろしいですか？',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  runTranscribe(ss, true);
}

function menuOpenLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);
  var sheet = ensureLogSheet(ss);
  ss.setActiveSheet(sheet);
}

function menuRebuildDashboard() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);
  rebuildDashboard(ss);
}

function menuWriteBackDryRun() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);
  ドライラン_目標管理書き戻し();
  SpreadsheetApp.getUi().alert(
    'ドライランを実行しました。\n\n' +
    '書き込み内容は実行ログで確認してください。\n' +
    '（拡張機能 > Apps Script > 実行数、または実行ログ）\n\n' +
    '※このドライランでは実際の書き込みは行っていません。'
  );
}

function menuWriteBackExecute() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  requireAdmin(ss);

  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    '目標管理シートへの書き戻し',
    '実績DBの内容を「目標管理（2026年4月～3月末)」シートの個人ブロックへ書き込みます。\n\n' +
    '※拠点・ITS・ENG・全社ブロックは対象外です。\n' +
    '※事前にドライランで内容を確認することを推奨します。\n\n' +
    '実行してよろしいですか？',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  実行_目標管理書き戻し();
}
