/**
 * 論文 007：本番の検索が実際に渡す文脈（prod-eval.ts の結果）で答えさせ、正しさを比べる
 * 使い方: node bench/rag-bench/prod-answers.cjs <ラベル> [<ラベル> ...]
 * - 100問（answer-eval.cjs と同じ選び方）。gemini-3.8-flash に文脈と質問だけを渡して答えさせる（本番の YUA の指示文ではない）
 * - 審査は gemini-3.8-flash が正解と比べて 2/1/0。どのやり方の答えかは知らせない
 * 出力: out/prod-answers.json
 */
const fs = require('fs');
const path = require('path');

const MODEL = 'gemini-3.8-flash';
const env = fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8');
const KEY = env.match(/^GEMINI_API_KEY="?([^"\n\\]+)/m)[1];
const OUT = path.join(__dirname, 'out');
const qs = JSON.parse(fs.readFileSync(path.join(OUT, 'questions.json'), 'utf8'));
const drop = new Set(JSON.parse(fs.readFileSync(path.join(OUT, 'drop-flagged.json'), 'utf8')));
const file = path.join(OUT, 'prod-answers.json');
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
const answerPrompt = (q, ctx) => `次の資料だけを使って、質問に日本語で短く答えてください。資料に答えがなければ「資料からはわかりません」と答えてください。\n\n${ctx}\n\n質問: ${q}`;
const judgePrompt = (q, ref, ans) => `質問に対する答えを、正解と比べて採点してください。\n質問: ${q}\n正解: ${ref}\n採点する答え: ${ans}\n\n2 = 正解と同じ内容が答えられている、1 = 一部だけ合っている、0 = ちがう、または答えられていない。\n答えは JSON だけ: {"score": 0|1|2, "reason": "短い理由"}`;

(async () => {
  const labels = process.argv.slice(2);
  const ctx = Object.fromEntries(labels.map((l) => [l, Object.fromEntries(JSON.parse(fs.readFileSync(path.join(OUT, `prod-${l}.json`), 'utf8')).map((r) => [r.q, r.context]))]));
  const jobs = [];
  for (const q of sample) for (const l of labels) if (!done[`${q.id}:${l}`] && ctx[l][q.id] !== undefined) jobs.push([q, l]);
  let saved = Date.now();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (jobs.length) {
      const [q, l] = jobs.shift();
      const a = await gen(answerPrompt(q.question, ctx[l][q.id] || '（資料なし）'));
      if (!a) continue;
      const j = await gen(judgePrompt(q.question, q.answer, a.text), true);
      let score = null; try { score = JSON.parse(j.text).score; } catch { /* 採点の失敗 */ }
      done[`${q.id}:${l}`] = { q: q.id, arm: l, answer: a.text, score, usage: [a.usage, j?.usage] };
      if (Date.now() - saved > 15000) { fs.writeFileSync(file, JSON.stringify(done)); saved = Date.now(); }
    }
  }));
  fs.writeFileSync(file, JSON.stringify(done, null, 1));
  for (const l of labels) {
    const rows = Object.values(done).filter((r) => r.arm === l && r.score !== null);
    const tin = rows.reduce((a, r) => a + (r.usage?.[0]?.promptTokenCount || 0), 0);
    console.log(l, '問題', rows.length, '正しい', rows.filter((r) => r.score === 2).length, '一部', rows.filter((r) => r.score === 1).length, '平均', (rows.reduce((a, r) => a + r.score, 0) / rows.length).toFixed(2), '答える側の入力トークン/問', Math.round(tin / rows.length));
  }
})();
