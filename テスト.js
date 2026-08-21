function 診断_9月ファイル中身() {
  const KAKUDO_FOLDER_ID = "0B4OryIRoXeGqSlRZdS00VENyTWM";
  const baseName = "エンジニア稼働一覧2026年09月度";

  try {
    const folder = DriveApp.getFolderById(KAKUDO_FOLDER_ID);
    const iter = folder.getFilesByName(baseName);

    if (!iter.hasNext()) {
      Logger.log("❌ 9月ファイルが見つかりません");
      return;
    }

    const file = iter.next();
    Logger.log("📄 ファイル名：" + file.getName());
    Logger.log("mimeType：" + file.getMimeType());

    const t0 = new Date();
    const ss = SpreadsheetApp.openById(file.getId());
    Logger.log("🔓 openById 所要：" + ((new Date() - t0) / 1000).toFixed(1) + "秒");

    // シート一覧
    const sheets = ss.getSheets();
    Logger.log("📑 シート数：" + sheets.length);
    sheets.forEach(function(s) {
      Logger.log("　・「" + s.getName() + "」");
    });

    // 個人数字シート
    const kojin = ss.getSheetByName("個人数字");
    Logger.log("🔍 「個人数字」：" + (kojin ? "✓ あり" : "❌ 無し"));

    if (kojin) {
      Logger.log("　最終行：" + kojin.getLastRow() + " / 最終列：" + kojin.getLastColumn());

      if (kojin.getLastRow() >= 3) {
        const rowCount = Math.min(15, kojin.getLastRow() - 2);
        const data = kojin.getRange(3, 1, rowCount, 34).getValues();
        Logger.log("　A列の名前と売上(W列)/粗利(AH列)：");
        data.forEach(function(row, i) {
          if (row[0]) {
            Logger.log("　　" + (i + 3) + ": 「" + row[0] + "」 売上=" + row[22] + " 粗利=" + row[33]);
          }
        });
      } else {
        Logger.log("　⚠️ データが3行未満（空の可能性）");
      }
    }

    // 稼働表3シート
    Logger.log("🏢 稼働表シート：");
    ["稼働表（東京）", "稼働表（大阪）", "稼働表（福岡）"].forEach(function(name) {
      const s = ss.getSheetByName(name);
      Logger.log("　・" + name + "：" + (s ? "✓" : "❌"));
    });

    Logger.log("✅ 診断完了");

  } catch (e) {
    Logger.log("エラー：" + e.message);
    Logger.log(e.stack);
  }
}