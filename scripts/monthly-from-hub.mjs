// 中間システム(GAS)の tagstats を呼んで、月ごとの人数(月次集計用)を、受け口(Supabase の app_data id=3)に保存する。
// GitHub Actions(.github/workflows/monthly-tagstats.yml)から、手動で実行する。人数だけで、名前や uid は扱わない。
//
// 環境変数:
//   HUB_URL / HUB_KEY  中間システムのURLと、この末端の合言葉(Secrets)。末端表の「許可友だち項目」に tags が必要
//   MONTHS             例: 2025-01:2026-10 (開始:終了)。省略すると 2025-01:2026-10
// テスト用: RESULT_FILE=ファイル名 を付けると、Supabase の代わりに、そのファイルへ書く。

import fs from 'node:fs';

const SB_URL = process.env.SB_URL || 'https://xzptkvciypgyygmhvhhs.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_wAsepmixI4NC16C59B6kbA_RmxzoZ7H';
const HUB_URL = (process.env.HUB_URL || '').trim();
const HUB_KEY = (process.env.HUB_KEY || '').trim();
const RESULT_FILE = process.env.RESULT_FILE || '';
const BATCH = 6;       // 1回の呼び出しで頼むカテゴリ数(送る本文を小さく、1回の処理を短くするため)

function monthList(spec) {
  const m = /^(\d{4})-(\d{2}):(\d{4})-(\d{2})$/.exec(spec || '2025-01:2026-10');
  if (!m) throw new Error('MONTHS は 2025-01:2026-10 の形で書いてください(いまは「' + spec + '」)');
  let y = +m[1], mo = +m[2];
  const out = [];
  while (y < +m[3] || (y === +m[3] && mo <= +m[4])) {
    out.push(y + '-' + String(mo).padStart(2, '0'));
    if (++mo > 12) { mo = 1; y++; }
    if (out.length > 60) throw new Error('月が多すぎます(最大60か月)');
  }
  return out;
}

async function hubPost(action, spec) {
  const body = new URLSearchParams({ a: action, key: HUB_KEY, spec: JSON.stringify(spec) });
  // GAS は、POST に 302 で答える。fetch は、それを GET で追いかけて、結果の JSON を受け取る
  const r = await fetch(HUB_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('中間システムに接続できませんでした(HTTP ' + r.status + ')');
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { throw new Error('中間システムの答えが読めません: ' + text.slice(0, 120)); }
}

async function save(result) {
  if (RESULT_FILE) { fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 1)); return; }
  const r = await fetch(SB_URL + '/rest/v1/app_data?on_conflict=id', {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 3, data: result })
  });
  if (!r.ok) throw new Error('結果の保存に失敗しました(' + r.status + ')');
}

async function main() {
  if (!HUB_URL || !HUB_KEY) throw new Error('HUB_URL と HUB_KEY が設定されていません(GitHub の Settings → Secrets)');
  const spec = JSON.parse(fs.readFileSync(new URL('./monthly-spec.json', import.meta.url), 'utf8'));
  const months = monthList(process.env.MONTHS);
  const result = { v: 1, at: new Date().toISOString(), months, metrics: Object.keys(spec.metrics), cats: {}, asOf: '', people: 0 };
  for (let i = 0; i < spec.cats.length; i += BATCH) {
    const part = spec.cats.slice(i, i + BATCH);
    const cats = {};
    part.forEach(c => { cats[c.category] = c.tags; });
    const r = await hubPost('tagstats', { months, cats, metrics: spec.metrics });
    if (!r.ok) throw new Error('中間システムがエラーを返しました: ' + r.error +
      (r.error === 'forbidden' ? '(末端表の「許可友だち項目」に tags を入れてください)' : r.error === 'unauthorized' ? '(合言葉が違う、または末端が停止になっています)' : ''));
    Object.assign(result.cats, r.cats);
    result.asOf = r.as_of || result.asOf; result.people = r.people;
    console.log('取得: ' + Object.keys(r.cats).join(' / '));
  }
  await save(result);
  console.log('保存しました: ' + Object.keys(result.cats).length + 'カテゴリ × ' + months.length + 'か月 / 友だちデータの時点 ' + result.asOf + ' / ' + result.people + '人');
}

main().catch(e => { console.error('エラー: ' + e.message); process.exit(1); });
