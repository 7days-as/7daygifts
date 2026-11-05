/**
 * 7daygifts.com — reviews & occasion votes backend.
 * Lives in the Google Sheet "7daygifts Reviews & Votes" (Extensions > Apps Script).
 * Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
 * Nothing written by visitors appears on the site until you approve it.
 */
var NOTIFY_EMAIL = 'info@7daygifts.com';
var SITE = 'https://7daygifts.com';
var OCCASIONS = { wedding7: '7 days before the wedding', birthday: 'Birthday', anniversary: 'Anniversary', justbecause: 'Just because', any: 'Any occasion' };
var TABS = {
  ratings: ['updated_at', 'product_id', 'voter_hash', 'stars', 'created_at'],
  votes: ['updated_at', 'product_id', 'voter_hash', 'occasions', 'created_at'],
  comments: ['comment_id', 'received_at', 'product_id', 'product_title', 'name', 'comment', 'status', 'decided_at'],
  approved_comments: ['comment_id', 'approved_at', 'product_id', 'name', 'comment', 'comment_date'],
  config: ['key', 'value', 'note']
};

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    noteUrl_();
    if (p.action === 'summary') return out_(summary_(String(p.id || '')), p.callback);
    if (p.action === 'all') return out_(all_(), p.callback);
    if (p.action === 'approve') return page_(decide_(p.id, p.t, 'approved'));
    if (p.action === 'reject') return page_(decide_(p.id, p.t, 'rejected'));
    if (p.action === 'ping') return out_({ ok: true }, p.callback);
    return page_('7daygifts reviews are connected and running. You can close this page.');
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) }, p.callback);
  }
}

function doPost(e) {
  var b = {};
  try { b = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { return out_({ ok: false, error: 'bad request' }); }
  try {
    noteUrl_();
    if (b.website) return out_({ ok: true }); // honeypot field: bots fill it, people never see it
    if (b.action === 'vote') return out_(vote_(b));
    if (b.action === 'rate') return out_(rate_(b));
    if (b.action === 'comment') return out_(comment_(b));
    return out_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------- reads ---------- */
function summary_(id) {
  id = cleanId_(id);
  if (!id) return { ok: false, error: 'missing id' };
  var r = ratingStats_()[id] || { sum: 0, n: 0 };
  var v = voteStats_()[id] || emptyVotes_();
  var comments = rows_('approved_comments').filter(function (c) { return String(c.product_id) === id; }).map(function (c) {
    return { name: String(c.name || ''), text: String(c.comment || ''), date: dateStr_(c.comment_date || c.approved_at) };
  }).reverse().slice(0, 20);
  return { ok: true, id: id, avg: r.n ? Math.round(r.sum / r.n * 10) / 10 : 0, count: r.n, votes: v.counts, voters: v.voters, top: topOccasion_(v), comments: comments };
}

function all_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('all');
  if (hit) return JSON.parse(hit);
  var rs = ratingStats_(), vs = voteStats_(), ids = {}, k;
  for (k in rs) ids[k] = 1;
  for (k in vs) ids[k] = 1;
  var products = {};
  for (k in ids) {
    var r = rs[k] || { sum: 0, n: 0 }, v = vs[k] || emptyVotes_();
    products[k] = { a: r.n ? Math.round(r.sum / r.n * 10) / 10 : 0, n: r.n, v: v.voters, t: topOccasion_(v) };
  }
  var res = { ok: true, products: products };
  try { cache.put('all', JSON.stringify(res), 120); } catch (x) {}
  return res;
}

function ratingStats_() {
  var s = {};
  rows_('ratings').forEach(function (r) {
    var n = Number(r.stars);
    if (!(n >= 1 && n <= 5)) return;
    var id = String(r.product_id);
    s[id] = s[id] || { sum: 0, n: 0 };
    s[id].sum += n; s[id].n++;
  });
  return s;
}

function emptyVotes_() { var c = {}; for (var k in OCCASIONS) c[k] = 0; return { counts: c, voters: 0 }; }

function voteStats_() {
  var s = {};
  rows_('votes').forEach(function (r) {
    var id = String(r.product_id);
    var occ = String(r.occasions || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return OCCASIONS[x]; });
    if (!occ.length) return;
    s[id] = s[id] || emptyVotes_();
    s[id].voters++;
    occ.forEach(function (o) { s[id].counts[o]++; });
  });
  return s;
}

// The occasion most voters picked. "Any" counts toward every occasion, and wins outright when it leads.
function topOccasion_(v) {
  if (!v || v.voters < 1) return '';
  var best = '', bestN = 0, any = v.counts.any || 0;
  for (var k in v.counts) {
    if (k === 'any') continue;
    var n = v.counts[k] + any;
    if (n > bestN) { best = k; bestN = n; }
  }
  if (any >= bestN - any && any > 0 && any * 2 >= v.voters) return 'any';
  return best;
}

/* ---------- writes ---------- */
function vote_(b) {
  var id = cleanId_(b.product_id), voter = String(b.voter || '').slice(0, 64);
  if (!id || voter.length < 8) return { ok: false, error: 'missing product or voter' };
  var occ = (Array.isArray(b.occasions) ? b.occasions : []).map(String).filter(function (x) { return OCCASIONS[x]; });
  if (occ.indexOf('any') >= 0) occ = ['any'];
  if (!occ.length) return { ok: false, error: 'pick at least one occasion' };
  if (!allow_('v:' + voter, 40, 3600) || !allow_('v:all', 300, 60)) return { ok: false, error: 'Too many votes right now — try again a little later.' };
  var hash = hash_('voter:' + voter);
  withLock_(function () { upsert_('votes', id, 'voter_hash', hash, { occasions: occ.join(',') }); });
  CacheService.getScriptCache().remove('all');
  return summary_(id);
}

function rate_(b) {
  var id = cleanId_(b.product_id), stars = Math.round(Number(b.stars));
  if (!id || !(stars >= 1 && stars <= 5)) return { ok: false, error: 'pick 1 to 5 stars' };
  var voter = String(b.voter || '').slice(0, 64);
  if (voter.length < 8) return { ok: false, error: 'missing voter' };
  if (!allow_('r:' + voter, 40, 3600) || !allow_('r:all', 300, 60)) return { ok: false, error: 'Too many ratings right now — try again a little later.' };
  var hash = hash_('voter:' + voter);
  withLock_(function () { upsert_('ratings', id, 'voter_hash', hash, { stars: stars }); });
  CacheService.getScriptCache().remove('all');
  var s = summary_(id); s.mine = stars; return s;
}

function comment_(b) {
  var id = cleanId_(b.product_id);
  var text = String(b.text || '').replace(/\s+$/, '').slice(0, 2000);
  var name = String(b.name || '').trim().slice(0, 60);
  var title = String(b.title || id).trim().slice(0, 150);
  if (!id || text.trim().length < 2) return { ok: false, error: 'Please write a comment first.' };
  var key = 'c:' + String(b.voter || 'anon').slice(0, 64);
  if (!allow_(key, 8, 3600) || !allow_('c:all', 60, 3600)) return { ok: false, error: 'Too many comments right now — try again later.' };
  var cid = 'C' + new Date().getTime().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
  withLock_(function () {
    sheet_('comments').appendRow([cid, new Date(), id, title, name, text, 'pending', '']);
  });
  notify_(cid, id, title, name, text, String(b.url || ''));
  return { ok: true, received: true };
}

function decide_(cid, token, status) {
  cid = String(cid || '');
  if (!cid || token !== sign_(cid)) return 'This link is not valid.';
  var msg = '';
  withLock_(function () {
    var sh = sheet_('comments'), data = sh.getDataRange().getValues(), head = data[0];
    var col = function (n) { return head.indexOf(n); };
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][col('comment_id')]) !== cid) continue;
      var cur = String(data[i][col('status')]);
      if (cur === status) { msg = 'Already ' + status + '.'; return; }
      sh.getRange(i + 1, col('status') + 1, 1, 2).setValues([[status, new Date()]]);
      var ap = sheet_('approved_comments');
      if (status === 'approved') {
        ap.appendRow([cid, new Date(), data[i][col('product_id')], data[i][col('name')] || '', data[i][col('comment')], data[i][col('received_at')]]);
      } else {
        var a = ap.getDataRange().getValues();
        for (var j = a.length - 1; j >= 1; j--) if (String(a[j][0]) === cid) ap.deleteRow(j + 1);
      }
      msg = status === 'approved' ? 'Approved. The comment now shows on the gift\u2019s page (it can take a couple of minutes).' : 'Hidden. The comment will not show on the site.';
      return;
    }
    msg = 'Comment not found.';
  });
  CacheService.getScriptCache().remove('all');
  return msg;
}

function notify_(cid, id, title, name, text, url) {
  var base = ScriptApp.getService().getUrl();
  var approve = base + '?action=approve&id=' + encodeURIComponent(cid) + '&t=' + sign_(cid);
  var reject = base + '?action=reject&id=' + encodeURIComponent(cid) + '&t=' + sign_(cid);
  var page = /^https:\/\/(www\.)?7daygifts(-preview\.sites\.tab\.bot|\.com)\//.test(url) ? url : SITE;
  var from = name || 'Someone (no name given)';
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var html = '<div style="font-family:Georgia,serif;font-size:16px;color:#222">' +
    '<p><b>' + esc(from) + '</b> wrote about <a href="' + esc(page) + '">' + esc(title) + '</a> (' + esc(id) + '):</p>' +
    '<blockquote style="border-left:3px solid #c9a24a;margin:0;padding:8px 14px;background:#faf6ec">' + esc(text).replace(/\n/g, '<br>') + '</blockquote>' +
    '<p>It is <b>not</b> on the site. Choose:</p>' +
    '<p><a href="' + approve + '" style="background:#1f3a2e;color:#fff;padding:10px 18px;border-radius:20px;text-decoration:none">Approve — show it on the site</a></p>' +
    '<p><a href="' + reject + '" style="color:#888">Keep it private</a> (or just ignore this email)</p>' +
    '<p style="color:#888;font-size:13px">All comments are also in your Sheet "7daygifts Reviews &amp; Votes", tab comments.</p></div>';
  MailApp.sendEmail({ to: cfg_('notify_email') || NOTIFY_EMAIL, subject: 'New comment on ' + title, htmlBody: html, body: from + ' wrote about ' + title + ':\n\n' + text + '\n\nApprove: ' + approve + '\nKeep private: ' + reject, name: '7daygifts.com' });
}

/* ---------- helpers ---------- */
function out_(obj, callback) {
  var s = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][\w$.]{0,60}$/.test(callback)) return ContentService.createTextOutput(callback + '(' + s + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}
function page_(msg) {
  return HtmlService.createHtmlOutput('<div style="font-family:Georgia,serif;font-size:20px;padding:40px 24px;max-width:520px;margin:auto;color:#1f3a2e"><p style="font-size:14px;letter-spacing:.1em;color:#a8863a">7DAYGIFTS.COM</p><p>' + String(msg).replace(/</g, '&lt;') + '</p></div>').setTitle('7daygifts').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function book_() {
  try { var a = SpreadsheetApp.getActiveSpreadsheet(); if (a) return a; } catch (x) {}
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID') || SHEET_ID_FALLBACK);
}
// A tiny published Sheet the website reads to find this script's address (it holds nothing else).
var PUBLIC_ADDRESS_SHEET = '19aHybi5Ar49VJ1kj09PTPCbLAkFIbReVX-MAicYT3jQ';
var SHEET_ID_FALLBACK = '1UhpVuN0ews3D1hOAbY-a5V1TgPMpmXLNUXgkXc5Bx8c';
function sheet_(name) {
  var b = book_(), sh = b.getSheetByName(name);
  if (!sh) { sh = b.insertSheet(name); sh.appendRow(TABS[name]); sh.setFrozenRows(1); }
  return sh;
}
function rows_(name) {
  var v = sheet_(name).getDataRange().getValues(), head = v[0] || [], out = [];
  for (var i = 1; i < v.length; i++) { var o = {}; for (var j = 0; j < head.length; j++) o[head[j]] = v[i][j]; out.push(o); }
  return out;
}
function upsert_(tab, id, keyCol, keyVal, fields) {
  var sh = sheet_(tab), data = sh.getDataRange().getValues(), head = data[0], now = new Date();
  var ci = head.indexOf('product_id'), ki = head.indexOf(keyCol);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][ci]) === id && String(data[i][ki]) === keyVal) {
      var rowv = data[i].slice();
      rowv[head.indexOf('updated_at')] = now;
      for (var f in fields) rowv[head.indexOf(f)] = fields[f];
      sh.getRange(i + 1, 1, 1, rowv.length).setValues([rowv]);
      return;
    }
  }
  var nr = head.map(function (h) { return h === 'updated_at' || h === 'created_at' ? now : h === 'product_id' ? id : h === keyCol ? keyVal : (h in fields ? fields[h] : ''); });
  sh.appendRow(nr);
}
function cfg_(key) {
  var cache = CacheService.getScriptCache(), hit = cache.get('cfg');
  var map = hit ? JSON.parse(hit) : null;
  if (!map) {
    map = {};
    rows_('config').forEach(function (r) { if (r.key) map[String(r.key).trim()] = String(r.value === undefined ? '' : r.value).trim(); });
    try { cache.put('cfg', JSON.stringify(map), 60); } catch (x) {}
  }
  return map[key] || '';
}
function noteUrl_() {
  var cache = CacheService.getScriptCache();
  if (cache.get('url_noted')) return;
  var url = ScriptApp.getService().getUrl();
  if (!url) return;
  if (cfg_('web_app_url') !== url) {
    withLock_(function () {
      var sh = sheet_('config'), v = sh.getDataRange().getValues();
      for (var i = 1; i < v.length; i++) if (v[i][0] === 'web_app_url') { sh.getRange(i + 1, 2).setValue(url); return; }
      sh.appendRow(['web_app_url', url, 'filled in automatically']);
    });
    cache.remove('cfg');
  }
  try {
    var cell = SpreadsheetApp.openById(PUBLIC_ADDRESS_SHEET).getSheets()[0].getRange('A2');
    if (cell.getValue() !== url) cell.setValue(url);
  } catch (x) {}
  cache.put('url_noted', '1', 21600);
}
function allow_(key, max, seconds) {
  var c = CacheService.getScriptCache(), n = Number(c.get('rl:' + key) || 0);
  if (n >= max) return false;
  c.put('rl:' + key, String(n + 1), seconds);
  return true;
}
function secret_() {
  var p = PropertiesService.getScriptProperties(), s = p.getProperty('SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SECRET', s); }
  return s;
}
function hex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function hash_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret_() + '|' + s, Utilities.Charset.UTF_8)).slice(0, 32); }
function sign_(s) { return hex_(Utilities.computeHmacSha256Signature(s, secret_(), Utilities.Charset.UTF_8)).slice(0, 32); }
function withLock_(fn) { var l = LockService.getScriptLock(); l.waitLock(20000); try { return fn(); } finally { l.releaseLock(); } }
function cleanId_(id) { id = String(id || '').trim(); return /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : ''; }
function dateStr_(d) { try { return Utilities.formatDate(new Date(d), 'America/New_York', 'MMM d, yyyy'); } catch (x) { return ''; } }
