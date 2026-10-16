/**
 * 論文 007：並べ替え役（LLM）で、上位50件を並べ直して上位20件を選ぶ（Anthropic は上位150件→20件を専用のリランカーで）
 * 使い方: node bench/rag-bench/rerank.cjs <形> [探し方=hybrid]
 * - モデルは gemini-3.5-flash-lite。質問と50件の切れ端（索引に入れた文そのまま）を見せ、関係の深い順に番号を並べさせる
 * - 正解の判定と物差しは evaluate.ts と同じ
 * 出力: out/rerank-<形>-<探し方>.json（問題ごと）と、まとめ
 */
const fs = require('fs');
const path = require('path');
const { build } = require('./variants.cjs');

const [NAME, MODE = 'hybrid'] = process.argv.slice(2);
const MODEL = process.env.RERANK_MODEL || 'gemini-3.5-flash-lite';
const WORKERS = 6;
const env = fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8');
const KEY = env.match(/^GEMINI_API_KEY="?([^"\n\\]+)/m)[1];
const OUT = path.join(__dirname, 'out');
const QSET = process.env.QSET || '';
const qs = JSON.parse(fs.readFileSync(path.join(OUT, QSET ? `questions-${QSET}.json` : 'questions.json'), 'utf8'));
const items = Object.fromEntries(build(NAME).map((i) => [i.id, i]));
const ev = JSON.parse(fs.readFileSync(path.join(OUT, `eval-${NAME}${QSET ? '-' + QSET : ''}.json`), 'utf8'))[MODE];
const file = path.join(OUT, `rerank-${NAME}-${MODE}${QSET ? '-' + QSET : ''}.json`);
const done = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

const norm = (s) => s.replace(/[\s。、．，・「」『』（）()【】:：!！?？"'“”]/g, '').toLowerCase();
function hit(raw, evidence) {
  const r = norm(raw); const e = norm(evidence);
  if (r.includes(e)) return true;
  const w = Math.ceil(e.length * 0.7);
  for (let i = 0; i + w <= e.length; i++) if (r.includes(e.slice(i, i + w))) return true;
  return false;
}

async function rerank(question, cands) {
  const list = cands.map((c, i) => `[${i + 1}] ${c.text.replace(/\s+/g, ' ').slice(0, 700)}`).join('\n\n');
  const text = `次の質問に答えるのに役立つ文書を、役立つ順に並べてください。\n質問: ${question}\n\n文書:\n${list}\n\n答えは、文書の番号を役立つ順に並べた JSON の配列だけ（例: [3, 1, 7, ...]）。役立つものを先に、少なくとも上位20件を並べること。`;
  const body = { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body) });
      if (res.ok) {
        const j = await res.json();
        const out = JSON.parse((j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text).join(''));
        const seen = new Set();
        const order = (Array.isArray(out) ? out : []).map(Number).filter((n) => n >= 1 && n <= cands.length && !seen.has(n) && seen.add(n)).map((n) => n - 1);
        // 並べなかった候補は、元の順で後ろにつける
        for (let i = 0; i < cands.length; i++) if (!seen.has(i + 1)) order.push(i);
        return { order, usage: j.usageMetadata };
      }
    } catch { /* もう一度 */ }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  return null;
}

(async () => {
  const todo = ev.filter((r) => !done[r.q]);
  let saved = Date.now();
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (todo.length) {
      const r = todo.shift();
      const q = qs.find((x) => x.id === r.q);
      const cands = r.top.slice(0, 50).map((id) => items[id]);
      const got = await rerank(q.question, cands);
      if (got) done[r.q] = { top: got.order.slice(0, 20).map((i) => cands[i].id), usage: got.usage };
      if (Date.now() - saved > 15000) { fs.writeFileSync(file, JSON.stringify(done)); saved = Date.now(); }
    }
  }));
  fs.writeFileSync(file, JSON.stringify(done));
  // 物差し
  const rows = qs.filter((q) => done[q.id]).map((q) => {
    const rel = done[q.id].top.map((id) => hit(items[id].raw, q.evidence));
    const first = rel.indexOf(true);
    return { miss20: first < 0 ? 1 : 0, hit5: first >= 0 && first < 5 ? 1 : 0, rr: first >= 0 ? 1 / (first + 1) : 0 };
  });
  const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  const u = Object.values(done).map((d) => d.usage || {});
  const tin = u.reduce((a, x) => a + (x.promptTokenCount || 0), 0); const tout = u.reduce((a, x) => a + (x.candidatesTokenCount || 0) + (x.thoughtsTokenCount || 0), 0);
  console.log(`${NAME} ${MODE}+並べ替え 問題 ${rows.length} 探し漏れ@20 ${(avg('miss20') * 100).toFixed(1)}% 上位5 ${(avg('hit5') * 100).toFixed(1)}% MRR ${avg('rr').toFixed(3)} 料金 $${((tin * 0.30 + tout * 2.5) / 1e6).toFixed(2)}`);
})();
