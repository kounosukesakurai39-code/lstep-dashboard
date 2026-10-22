// Lステップ中間システム(GAS)から毎朝、記録を受け取って、受け口(Supabase の app_data id=2)に集計を保存する。
// GitHub Actions(.github/workflows/lstep-sync.yml)から実行する。画面の「取り込む」ボタンと、同じ数え方。
//
// 必要な環境変数(GitHub の Secrets に登録する):
//   HUB_URL  中間システムのURL(…/exec)
//   HUB_KEY  この末端の合言葉(tk_…)   ← コードやログには出さない
// テスト用: INBOX_FILE=ファイル名 を付けると、Supabase の代わりに、そのファイルを読み書きする。
//
// ※ 数え方の部分(hub〜 の関数)は、lstep_dashboard.html の同じ関数と、そのまま同じものを写している。
//    画面側の数え方を変えたときは、ここも同じに直すこと。

import fs from 'node:fs';

const SB_URL = process.env.SB_URL || 'https://xzptkvciypgyygmhvhhs.supabase.co';
const SB_KEY = process.env.SB_KEY || 'sb_publishable_wAsepmixI4NC16C59B6kbA_RmxzoZ7H';
const HUB_URL = (process.env.HUB_URL || '').trim();
const HUB_KEY = (process.env.HUB_KEY || '').trim();
const INBOX_FILE = process.env.INBOX_FILE || '';

// ---------------------------------------------------------------- 画面と同じ数え方(そのまま写し)
function hubNewInbox() { return { v: 1, lastId: 0, asOf: '', lastPulledAt: '', raws: [], counts: {}, first: {}, map: {} }; }

function hubHash(str) {
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (var i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function hubPeriodKey(at) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(at || ''));
  if (!m) return null;
  var d = parseInt(m[3], 10);
  return m[1] + '-' + m[2] + '-P' + (d <= 10 ? 1 : d <= 20 ? 2 : 3);
}

function hubBump(inbox, raw, period, delta) {
  var c = inbox.counts[raw] || (inbox.counts[raw] = {});
  c[period] = Math.max(0, (c[period] || 0) + delta);
}

function hubRawIdx(inbox, raw) {
  var i = inbox.raws.indexOf(raw);
  if (i < 0) { inbox.raws.push(raw); i = inbox.raws.length - 1; }
  return i;
}

var HUB_STAGE_GROUPS = { '来場': 'vis', '成約確定': 'con' };

function hubApplyRows(inbox, rows) {
  inbox.lastIdBy = inbox.lastIdBy || {};
  inbox.rt = inbox.rt || {}; inbox.chan = inbox.chan || {}; inbox.vis = inbox.vis || {}; inbox.con = inbox.con || {};
  if (inbox.lastIdBy['流入経路'] === undefined && inbox.lastId > 0) inbox.lastIdBy['流入経路'] = inbox.lastId;
  var start = Object.assign({}, inbox.lastIdBy), seenMax = {}, processed = 0;
  rows.forEach(function(r) {
    var id = Number(r.id), g = r.group;
    var isStage = HUB_STAGE_GROUPS[g] !== undefined;
    if (g !== '流入経路' && !isStage) return;
    if (!(id > (start[g] || 0))) return;
    seenMax[g] = Math.max(seenMax[g] || 0, id);
    var uid = String(r.uid || '');
    var date = String(r.event_at || '').slice(0, 10);
    if (isStage) {
      if (!uid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      var store = inbox[HUB_STAGE_GROUPS[g]], hh = hubHash(uid);
      if (!store[hh] || date < store[hh]) store[hh] = date;
      processed++;
      return;
    }
    var period = hubPeriodKey(r.event_at);
    if (!period) return;
    var raw = r.channel_raw || r.channel || '(経路不明)';
    if (r.channel) inbox.chan[raw] = [r.channel, r.channel_sub || ''];
    var fp = String(r.first_pass == null ? '' : r.first_pass).toLowerCase();
    if (fp === 'false') return;
    processed++;
    if (fp === 'true') {
      hubBump(inbox, raw, period, 1);
      if (uid) {
        var th = hubHash(uid), ti = hubRawIdx(inbox, raw), tp = inbox.rt[th];
        if (!tp || date < tp[0]) inbox.rt[th] = [date, ti];
      }
      return;
    }
    if (!uid) return;
    var h = hubHash(uid), idx = hubRawIdx(inbox, raw), prev = inbox.first[h];
    if (!prev) {
      inbox.first[h] = [date, idx];
      hubBump(inbox, raw, period, 1);
    } else if (date < prev[0]) {
      hubBump(inbox, inbox.raws[prev[1]], hubPeriodKey(prev[0]), -1);
      inbox.first[h] = [date, idx];
      hubBump(inbox, raw, period, 1);
    }
  });
  Object.keys(seenMax).forEach(function(g) { inbox.lastIdBy[g] = Math.max(inbox.lastIdBy[g] || 0, seenMax[g]); });
  return processed;
}

// ---------------------------------------------------------------- 入出力
const sbHeaders = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };

async function loadInbox() {
  if (INBOX_FILE) {
    if (!fs.existsSync(INBOX_FILE)) return hubNewInbox();
    return Object.assign(hubNewInbox(), JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8')));
  }
  const r = await fetch(SB_URL + '/rest/v1/app_data?id=eq.2&select=data', { headers: sbHeaders });
  if (!r.ok) throw new Error('受け口の読み込みに失敗しました(' + r.status + ')');
  const rows = await r.json();
  const d = rows[0] && rows[0].data;
  return (d && d.v === 1 && d.counts) ? Object.assign(hubNewInbox(), d) : hubNewInbox();
}

async function saveInbox(inbox) {
  if (INBOX_FILE) { fs.writeFileSync(INBOX_FILE, JSON.stringify(inbox)); return; }
  const r = await fetch(SB_URL + '/rest/v1/app_data?on_conflict=id', {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 2, data: inbox })
  });
  if (!r.ok) throw new Error('受け口の保存に失敗しました(' + r.status + ')');
}

async function hubCall(action, params) {
  const q = new URLSearchParams({ a: action, key: HUB_KEY, ...(params || {}) });
  const r = await fetch(HUB_URL + (HUB_URL.includes('?') ? '&' : '?') + q.toString());
  if (!r.ok) throw new Error('中間システムに接続できませんでした(HTTP ' + r.status + ')');
  return r.json();
}

// ---------------------------------------------------------------- 本体
async function main() {
  if (!HUB_URL || !HUB_KEY) throw new Error('HUB_URL と HUB_KEY が設定されていません(GitHub の Settings → Secrets)');
  const inbox = await loadInbox();
  let total = 0, rounds = 0, prevUpto = -1;
  const startedAt = new Date().toISOString();
  while (rounds++ < 1000) {
    const r = await hubCall('pull', { limit: '200' });
    if (!r.ok) throw new Error('中間システムがエラーを返しました: ' + r.error + (r.error === 'unauthorized' ? '(合言葉が違う、または末端が停止になっています)' : ''));
    const upto = Number(r.upto) || 0;
    total += hubApplyRows(inbox, r.rows || []);
    if (r.as_of) inbox.asOf = r.as_of;
    inbox.lastId = Math.max(inbox.lastId, upto);
    inbox.lastPulledAt = new Date().toISOString();
    inbox.lastAuto = { at: inbox.lastPulledAt, ok: true, counted: total };
    await saveInbox(inbox);                       // 保存できてから
    if (upto > 0) {
      const a = await hubCall('ack', { upto: String(upto) });   // 「受け取れた」を返す
      if (!a.ok) throw new Error('「受け取れた」の返却に失敗しました: ' + a.error);
    }
    if (!r.has_more || upto <= prevUpto) break;
    prevUpto = upto;
  }
  console.log('取り込み完了: 登録などとして数えた記録 ' + total + '件 / 取り込み済みid ' + inbox.lastId + ' / データの時点 ' + (inbox.asOf || '-') + ' / 開始 ' + startedAt);
}

main().catch(async (e) => {
  console.error('エラー: ' + e.message);
  try {   // 失敗したことを、受け口にも残す(画面で分かるように)
    const inbox = await loadInbox();
    inbox.lastAuto = { at: new Date().toISOString(), ok: false, error: String(e.message).slice(0, 200) };
    await saveInbox(inbox);
  } catch (e2) { /* 記録できなくても、元のエラーで終わる */ }
  process.exit(1);
});
