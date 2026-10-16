/**
 * 論文 007：探した結果で、答えそのものが良くなるか（100問）
 * 使い方: node bench/rag-bench/answer-eval.cjs
 * - 形：prod（本番の切り方・本番の重み）、dense（本番の切り方・埋め込みだけ）、rerank（本番の切り方・等しい重み＋並べ替え役）
 * - 上位5件の切れ端だけを渡して、gemini-3.8-flash（本番のチャットと同じモデル）に答えさせる。本番の YUA の指示文ではなく、簡単な決まった指示
 * - 審査：gemini-3.8-flash が、問題の答え（正解）と比べて 2=正しい・1=一部・0=ちがう／答えられない。どの形の答えかは知らせない
 * 出力: out/answers.json
 */
const fs = require('fs');
const path = require('path');
const { build } = require('./variants.cjs');

const MODEL = 'gemini-3.8-flash';
const env = fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8');
const KEY = env.match(/^GEMINI_API_KEY="?([^"\n\\]+)/m)[1];
const OUT = path.join(__dirname, 'out');
const qs = JSON.parse(fs.readFileSync(path.join(OUT, 'questions.json'), 'utf8'));
const drop = new Set(JSON.parse(fs.readFileSync(path.join(OUT, 'drop-flagged.json'), 'utf8')));
const A = Object.fromEntries(build('A').map((i) => [i.id, i]));
const ev = JSON.parse(fs.readFileSync(path.join(OUT, 'eval-A.json'), 'utf8'));
const rr = JSON.parse(fs.readFileSync(path.join(OUT, 'rerank-A-hybrid.json'), 'utf8'));
const top = {
  prod: Object.fromEntries(ev.hybridProd.map((r) => [r.q, r.top.slice(0, 5)])),
  dense: Object.fromEntries(ev.dense.map((r) => [r.q, r.top.slice(0, 5)])),
  rerank: Object.fromEntries(Object.entries(rr).map(([q, r]) => [q, r.top.slice(0, 5)])),
};
const file = path.join(OUT, 'answers.json');
const done = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

let seed = 7020;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const sample = qs.filter((q) => !drop.has(q.id)).map((q) => [rand(), q]).sort((a, b) => a[0] - b[0]).slice(0, 100).map(([, q]) => q);

async function gen(text, json) {
  const body = { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0, ...(json ? { responseMimeType: 'application/json' } : {}) } };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body) });
      if (res.ok) { const j = await res.json(); return { text: (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text).join('').trim(), usage: j.usageMetadata }; }
    } catch { /* もう一度 */ }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  return null;
}

const answerPrompt = (q, ids) => `次の資料だけを使って、質問に日本語で短く答えてください。資料に答えがなければ「資料からはわかりません」と答えてください。\n\n${ids.map((id, i) => `資料${i + 1}: ${A[id].raw}`).join('\n\n')}\n\n質問: ${q}`;
const judgePrompt = (q, ref, ans) => `質問に対する答えを、正解と比べて採点してください。\n質問: ${q}\n正解: ${ref}\n採点する答え: ${ans}\n\n2 = 正解と同じ内容が答えられている、1 = 一部だけ合っている、0 = ちがう、または答えられていない。\n答えは JSON だけ: {"score": 0|1|2, "reason": "短い理由"}`;

(async () => {
  const jobs = [];
  for (const q of sample) for (const arm of Object.keys(top)) if (!done[`${q.id}:${arm}`] && top[arm][q.id]) jobs.push([q, arm]);
  let saved = Date.now();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (jobs.length) {
      const [q, arm] = jobs.shift();
      const a = await gen(answerPrompt(q.question, top[arm][q.id]));
      if (!a) continue;
      const j = await gen(judgePrompt(q.question, q.answer, a.text), true);
      let score = null; try { score = JSON.parse(j.text).score; } catch { /* 採点の失敗 */ }
      done[`${q.id}:${arm}`] = { q: q.id, arm, answer: a.text, score, usage: [a.usage, j?.usage] };
      if (Date.now() - saved > 15000) { fs.writeFileSync(file, JSON.stringify(done)); saved = Date.now(); }
    }
  }));
  fs.writeFileSync(file, JSON.stringify(done, null, 1));
  for (const arm of Object.keys(top)) {
    const rows = Object.values(done).filter((r) => r.arm === arm && r.score !== null);
    console.log(arm, '問題', rows.length, '正しい', rows.filter((r) => r.score === 2).length, '一部', rows.filter((r) => r.score === 1).length, '平均', (rows.reduce((a, r) => a + r.score, 0) / rows.length).toFixed(2));
  }
})();
