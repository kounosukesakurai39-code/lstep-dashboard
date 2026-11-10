// インフルエンサータブの記録(app_data id=1 の records)を、Lステップ(中間システムの friendlist)と照合・更新する。
// GitHub Actions(.github/workflows/influencer-sync.yml)から実行する。
//   MODE=check  照合だけ(書き込まない)。数字だけの報告を、受け口(id=4)に保存する。
//   MODE=apply  新しい登録者を追加し、Lステップで対応マークが変わった人の状態を更新する。削除はしない。
// 環境変数: HUB_URL / HUB_KEY(Secrets。末端表の「許可友だち項目」に tags, name, full_name が必要) / ALIGN_STATUS / MODE
// テスト用: MAIN_FILE=ファイル(id=1 の代わり) / OUT_FILE=ファイル(報告・変更記録の保存先の代わり)
//
// 決まり:
//  - 記録の lineId と、Lステップの友だちID(id)を、つなぎ目にする。
//  - 状態は、Lステップの対応マークが「前回(lsMark)から変わったとき」だけ更新する。手で直した状態は、Lステップが変わらない限り、上書きしない。
//    ただし ALIGN_STATUS=true のときは、一度だけ、すべての状態をLステップの対応マークにそろえる(変更前は id=5 に残る)。
//  - 名前は、新しい登録者は「本名(full_name)があれば本名、なければ表示名」。既存の記録は、名前が空・「（名前なし）」・Lステップの表示名のままのときだけ、本名に置き換える(手で直した名前は触らない)。
//  - 名前・売上・手術などの手入力の項目は、既存の記録では変えない。
//  - つなぎ目が合わない(一致が8割未満)ときは、重複を作らないように、書き込まずに止まる。

import fs from 'node:fs';

const SB_URL = process.env.SB_URL || 'https://xzptkvciypgyygmhvhhs.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_wAsepmixI4NC16C59B6kbA_RmxzoZ7H';
const HUB_URL = (process.env.HUB_URL || '').trim();
const HUB_KEY = (process.env.HUB_KEY || '').trim();
const MODE = (process.env.MODE || 'check').trim();
const ALIGN = ['1', 'true', 'yes'].includes(String(process.env.ALIGN_STATUS || '').trim().toLowerCase());   // true: 状態を、Lステップの対応マークに一度そろえる
const MAIN_FILE = process.env.MAIN_FILE || '';
const OUT_FILE = process.env.OUT_FILE || '';
const MIN_MATCH = 0.8;
const map = JSON.parse(fs.readFileSync(new URL('./influencer-map.json', import.meta.url), 'utf8'));

const sbH = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
async function loadMain() {
  if (MAIN_FILE) return JSON.parse(fs.readFileSync(MAIN_FILE, 'utf8'));
  const r = await fetch(SB_URL + '/rest/v1/app_data?id=eq.1&select=data', { headers: sbH });
  if (!r.ok) throw new Error('記録の読み込みに失敗しました(' + r.status + ')');
  return (await r.json())[0].data;
}
async function saveMain(d) {
  if (MAIN_FILE) { fs.writeFileSync(MAIN_FILE, JSON.stringify(d)); return; }
  const r = await fetch(SB_URL + '/rest/v1/app_data?id=eq.1', { method: 'PATCH', headers: { ...sbH, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ data: d }) });
  if (!r.ok) throw new Error('記録の保存に失敗しました(' + r.status + ')');
}
async function saveRow(id, data) {
  if (OUT_FILE) { const o = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {}; o[id] = data; fs.writeFileSync(OUT_FILE, JSON.stringify(o, null, 1)); return; }
  const r = await fetch(SB_URL + '/rest/v1/app_data?on_conflict=id', { method: 'POST', headers: { ...sbH, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ id, data }) });
  if (!r.ok) throw new Error('結果の保存に失敗しました(' + r.status + ')');
}

async function hubPost(spec, offset) {
  const body = new URLSearchParams({ a: 'friendlist', key: HUB_KEY, spec: JSON.stringify(spec), offset: String(offset), limit: '500' });
  const r = await fetch(HUB_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('中間システムに接続できませんでした(HTTP ' + r.status + ')');
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { throw new Error('中間システムの答えが読めません: ' + t.slice(0, 120)); }
  if (!j.ok) throw new Error('中間システムがエラーを返しました: ' + j.error +
    (j.error === 'forbidden' ? '(末端表の「許可友だち項目」に tags と name と full_name を入れてください)' : j.error === 'unauthorized' ? '(合言葉が違う、または末端が停止になっています)' : ''));
  return j;
}
async function fetchFriends(tags) {
  const all = []; let off = 0, asOf = '';
  for (let i = 0; i < 200; i++) {
    const j = await hubPost({ tags }, off);
    all.push(...j.rows); asOf = j.as_of || asOf;
    if (j.next == null) break;
    off = j.next;
  }
  return { friends: all, asOf };
}

// 友だち → 流入元(記録の source)。持っているタグのうち、いちばん早く付いたものを、流入元にする
function sourceOf(f, tagToSource) {
  let best = null;
  f.tags.forEach(t => {
    const s = tagToSource[t.name]; if (!s) return;
    const at = t.attached_on || '9999-99-99';
    if (!best || at < best.at) best = { at, s };
  });
  return best ? best.s : null;
}
const effMark = f => f.blocked ? 'ブロック' : (f.mark || '');
const day = s => String(s || '').slice(0, 10);
const norm = s => String(s || '').replace(/[\s　]/g, '');
// 既存の記録の名前を本名に置き換えてよいか(名前が空・「（名前なし）」・Lステップの表示名のまま、のとき)
const autoName = (r, f) => { const n = norm(r.name); return !n || n === norm('（名前なし）') || (!!f.name && n === norm(f.name)); };
const wantRealName = (r, f) => !!(f.full_name && norm(f.full_name) !== norm(r.name) && autoName(r, f));

async function main() {
  if (!HUB_URL || !HUB_KEY) throw new Error('HUB_URL と HUB_KEY が設定されていません(GitHub の Settings → Secrets)');
  if (MODE !== 'check' && MODE !== 'apply') throw new Error('MODE は check か apply です(いまは「' + MODE + '」)');
  const tagToSource = {}; const allTags = [];
  Object.keys(map.sources).forEach(s => map.sources[s].forEach(t => { tagToSource[t] = s; allTags.push(t); }));
  const { friends, asOf } = await fetchFriends(allTags);
  const d = await loadMain();
  const statuses = d.statuses || [];
  const inMap = new Set(Object.keys(map.sources));
  const recs = d.records.filter(r => inMap.has(r.source));
  const byId = new Map(); friends.forEach(f => byId.set(String(f.id), f));
  const recById = new Map(); d.records.forEach(r => recById.set(String(r.lineId), r));

  // ---- 照合の報告(数字だけ)
  const rep = { v: 1, at: new Date().toISOString(), mode: MODE, asOf, friends: friends.length, hasNames: friends.some(f => 'name' in f),
    recordsInScope: recs.length, matched: 0, unmatchedRecords: 0, newFriends: 0, bySource: {}, statusSame: 0, statusDiff: 0, statusDiffTop: {},
    sourceMismatch: 0, nameSame: 0, nameDiff: 0, namesChecked: 0, regSame: 0, regDiff: 0, unknownMarks: {}, hasFullNames: friends.some(f => 'full_name' in f), fullNameFilled: friends.filter(f => f.full_name).length, nameWillChange: 0 };
  Object.keys(map.sources).forEach(s => rep.bySource[s] = { records: 0, matched: 0, friends: 0, newFriends: 0 });
  recs.forEach(r => rep.bySource[r.source].records++);
  const diffTop = {};
  friends.forEach(f => {
    const src = sourceOf(f, tagToSource); if (!src) return;
    rep.bySource[src].friends++;
    const r = recById.get(String(f.id));
    const m = effMark(f);
    if (m && statuses.length && statuses.indexOf(m) < 0) rep.unknownMarks[m] = (rep.unknownMarks[m] || 0) + 1;
    if (!r) { rep.newFriends++; rep.bySource[src].newFriends++; return; }
    if (!inMap.has(r.source)) return;
    rep.matched++; rep.bySource[r.source].matched++;
    if (src !== r.source) rep.sourceMismatch++;
    if (m === r.status) rep.statusSame++; else { rep.statusDiff++; const k = r.status + ' → ' + (m || '(なし)'); diffTop[k] = (diffTop[k] || 0) + 1; }
    if ('name' in f && f.name) { rep.namesChecked++; if (norm(f.name) === norm(r.name)) rep.nameSame++; else rep.nameDiff++; }
    if (r.registeredAt) { if (day(f.created_at) === r.registeredAt) rep.regSame++; else rep.regDiff++; }
    if (wantRealName(r, f)) rep.nameWillChange++;
  });
  rep.unmatchedRecords = recs.length - rep.matched;
  rep.matchRate = recs.length ? +(rep.matched / recs.length).toFixed(3) : 0;
  rep.statusDiffTop = Object.fromEntries(Object.entries(diffTop).sort((a, b) => b[1] - a[1]).slice(0, 12));
  console.log(JSON.stringify(rep, null, 1));
  await saveRow(4, rep);
  console.log('照合の報告を保存しました(受け口 id=4)');
  if (MODE === 'check') return;

  // ---- 書き込み
  if (rep.matchRate < MIN_MATCH) throw new Error('つなぎ目(lineId と友だちID)の一致が ' + Math.round(rep.matchRate * 100) + '% しかありません。重複を作らないように、書き込まずに止まりました');
  const fresh = await loadMain();                       // 直前に読み直して、そこに足す(他で変わっていた分を消さないため)
  const now = new Date().toISOString();
  const log = { v: 1, at: now, changed: [], added: [] };
  const freshById = new Map(); fresh.records.forEach(r => freshById.set(String(r.lineId), r));
  let nextId = Math.max(fresh.nextId || 0, ...fresh.records.map(r => (r.id || 0) + 1));   // nextId は「次に使う番号」
  const stat = fresh.statuses || [];
  friends.forEach(f => {
    const src = sourceOf(f, tagToSource); if (!src) return;
    const m = effMark(f);
    const r = freshById.get(String(f.id));
    if (!r) {
      const rec = { id: nextId++, name: f.full_name || f.name || '（名前なし）', lineId: String(f.id), source: src,
        status: stat.indexOf(m) >= 0 ? m : '【未】アンケ', updatedAt: now, lsMark: m };
      if (f.created_at) rec.registeredAt = day(f.created_at);
      fresh.records.push(rec); log.added.push(rec.id);
      return;
    }
    if (!inMap.has(r.source)) return;
    const before = { status: r.status, lsMark: r.lsMark, registeredAt: r.registeredAt, updatedAt: r.updatedAt };
    let ch = false;
    if (r.lsMark === undefined) { r.lsMark = m; ch = true; }                       // 初回: 比べる基準だけ記録。状態は変えない
    else if (m !== r.lsMark) { if (stat.indexOf(m) >= 0) r.status = m; r.lsMark = m; r.updatedAt = now; ch = true; }
    if (ALIGN && stat.indexOf(m) >= 0 && r.status !== m) { r.status = m; r.lsMark = m; r.updatedAt = now; ch = true; }   // 一度だけ、状態をLステップにそろえる
    if (wantRealName(r, f)) { r.name = f.full_name; r.updatedAt = r.updatedAt || now; before.nameWasAuto = true; ch = true; }   // 変更前の名前は、記録に残さない(個人情報)
    if (!r.registeredAt && f.created_at) { r.registeredAt = day(f.created_at); ch = true; }
    if (ch) log.changed.push({ id: r.id, before });
  });
  fresh.nextId = nextId;
  if (!Array.isArray(fresh.sources)) fresh.sources = [];
  Object.keys(map.sources).forEach(s => { if (fresh.sources.indexOf(s) < 0) fresh.sources.push(s); });   // 新しい経路はプルダウンに出す
  await saveRow(5, log);                                 // 戻せるように、変更の記録を先に保存(名前は入れない)
  await saveMain(fresh);
  console.log('書き込みました: 追加 ' + log.added.length + '人 / 更新 ' + log.changed.length + '人(変更の記録は受け口 id=5)');
}

main().catch(e => { console.error('エラー: ' + e.message); process.exit(1); });
