/**
 * 論文 007：形ごとに「索引に入れる文」を組み立てる（埋め込みと BM25 で同じものを使う）
 * - A  本番の切り方（約500文字）・何も添えない
 * - As 本番の切り方で、平均の長さを struct にそろえたもの（長さの対照）
 * - B  A ＋ LLM の説明文（Anthropic の Contextual Retrieval）
 * - C  見出しで切る・何も添えない
 * - D  C ＋ 本物の見出しの道筋（題名 > h2 > h3）
 * - E  C ＋ 偽の見出しの道筋（同じ文書の中で道筋を入れ替えたもの）＝偽の対照
 * - F  C ＋ 見出しの道筋 ＋ LLM の説明文
 * 正解の判定は、添えた文ではなく、切れ端の本文（raw）で行う
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const load = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const loadCtx = (kind) => {
  const ctx = load(`contexts-${kind}.json`);
  return (id) => ctx[id]?.context || '';
};

// 偽の道筋：同じ文書の切れ端どうしで、道筋をずらして入れ替える（自分の道筋が残らないよう、ちがう道筋の切れ端と交換する）
function placeboPaths(chunks) {
  let seed = 7008;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const byDoc = {};
  for (const c of chunks) (byDoc[c.doc] ||= []).push(c);
  const out = {};
  for (const list of Object.values(byDoc)) {
    const paths = list.map((c) => c.path);
    const order = paths.map((_, i) => i).sort(() => rand() - 0.5);
    list.forEach((c, i) => {
      // 自分と同じ道筋にならない相手を、乱数の順で探す
      let j = order.find((k) => paths[k].join('>') !== c.path.join('>'));
      if (j === undefined) j = order[i];
      order.splice(order.indexOf(j), 1);
      order.push(j);
      out[c.id] = paths[j];
    });
  }
  return out;
}

const pathText = (p) => p.join(' > ');

function build(name) {
  if (name === 'A') return load('chunks-fixed.json').map((c) => ({ id: c.id, doc: c.doc, raw: c.text, text: c.text }));
  if (name === 'As') return load('chunks-fixed-short.json').map((c) => ({ id: c.id, doc: c.doc, raw: c.text, text: c.text }));
  if (name === 'B') { const ctx = loadCtx('fixed'); return load('chunks-fixed.json').map((c) => ({ id: c.id, doc: c.doc, raw: c.text, text: `${ctx(c.id)}\n\n${c.text}` })); }
  const s = load('chunks-struct.json');
  if (name === 'C') return s.map((c) => ({ id: c.id, doc: c.doc, raw: c.text, text: c.text }));
  if (name === 'D') return s.map((c) => ({ id: c.id, doc: c.doc, raw: c.text, text: `${pathText(c.path)}\n\n${c.text}` }));
  if (name === 'E') { const fake = placeboPaths(s); return s.map((c) => ({ id: c.id, doc: c.doc, raw: c.text, text: `${pathText(fake[c.id])}\n\n${c.text}` })); }
  if (name === 'F') { const ctx = loadCtx('struct'); return s.map((c) => ({ id: c.id, doc: c.doc, raw: c.text, text: `${pathText(c.path)}\n${ctx(c.id)}\n\n${c.text}` })); }
  throw new Error('知らない形: ' + name);
}

module.exports = { build, VARIANTS: ['A', 'As', 'B', 'C', 'D', 'E', 'F'] };
