/**
 * 論文 007：日本語の品詞で切る言葉の切り方（kuromoji、IPA 辞書）
 * 名詞・動詞・形容詞・副詞の「もとの形」だけを使い、助詞・助動詞・記号は捨てる（日本語の BM25 でよく使うやり方）
 */
const path = require('path');
const kuromoji = require('kuromoji');
const KEEP = new Set(['名詞', '動詞', '形容詞', '副詞']);
const DROP_SUB = new Set(['非自立', '代名詞', '数', '接尾']);
let tk = null;
function init() {
  return new Promise((res, rej) => kuromoji.builder({ dicPath: path.join(__dirname, 'node_modules/kuromoji/dict') }).build((e, t) => (e ? rej(e) : res((tk = t)))));
}
function tokenize(text) {
  return tk.tokenize(text.toLowerCase()).filter((m) => KEEP.has(m.pos) && !DROP_SUB.has(m.pos_detail_1))
    .map((m) => (m.basic_form && m.basic_form !== '*' ? m.basic_form : m.surface_form)).filter((w) => w.trim().length > 0);
}
module.exports = { init, tokenize };
