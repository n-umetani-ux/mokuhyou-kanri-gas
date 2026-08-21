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
