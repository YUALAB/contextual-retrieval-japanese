/**
 * 論文 007：問題集を作る（1文書あたり2問、全300問）
 * 使い方: node bench/rag-bench/gen-questions.cjs
 * - 文書の中から、どの切り分けの境目にもそろえない「数文のまとまり」を乱数で選び、そこだけで答えられる質問を作らせる
 * - 答えの根拠になる短い一文（本文からそのまま抜き出し）も返させ、本文に本当にあるかを確かめる
 * - 本文と同じ言葉をなるべく使わず、利用者が実際に聞きそうな言い方にさせる（言葉で探す側が有利になりすぎないように）
 * 出力: out/questions.json（STYLE=literal なら out/questions-literal.json）
 */
const fs = require('fs');
const path = require('path');

const MODEL = process.env.QGEN_MODEL || 'gemini-3.8-flash';
// STYLE=literal：本文の言葉をそのまま使ってよい質問（言い換えの問題集が BM25 に不利すぎないかの確かめ用。1文書1問）
const LITERAL = process.env.STYLE === 'literal';
const env = fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8');
const KEY = env.match(/^GEMINI_API_KEY="?([^"\n\\]+)/m)[1];
const OUT = path.join(__dirname, 'out');
const docs = JSON.parse(fs.readFileSync(path.join(OUT, 'corpus.json'), 'utf8'));

let seed = LITERAL ? 7107 : 7007;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const norm = (s) => s.replace(/[\s。、．，・「」『』（）()]/g, '').toLowerCase();

const INSTRUCTION = `あなたは、AQUA合同会社のブログを読んだ利用者が、AIアシスタントに聞きそうな質問を作る係です。
下の「一節」だけを読んで、その一節に答えが書いてある質問を1つ作ってください。
決まり:
${LITERAL ? '- 質問は、一節を見ていない人が自然に聞く言い方にする。一節に出てくる言葉は、そのまま使ってよい' : '- 質問は、一節を見ていない人が自然に聞く言い方にする。一節と同じ言葉や言い回しは、なるべく使わず言い換える（固有名詞は使ってよい）'}
- 「この記事」「この一節」「筆者」のような、文書を見ている前提の言い方はしない
- 一節の中の、答えの根拠になる部分を、一節からそのまま（1文字も変えずに）20〜80文字で抜き出す
- 一節の内容だけでは答えられない質問、はい/いいえで終わる質問は作らない
答えは次の JSON だけ: {"question": "質問", "answer": "短い答え", "evidence": "一節からそのまま抜き出した根拠"}`;

function passages(doc) {
  // 本文を「。」で文に分け、どの切り分けともそろわない位置から 3〜5 文を選ぶ（前半と後半から1つずつ）
  const body = doc.text.split('\n\n').slice(1).join(' ');
  const sents = body.split(/(?<=[。！？])/).map((s) => s.trim()).filter((s) => s.length >= 8);
  if (sents.length < 8) return [];
  const half = Math.floor(sents.length / 2);
  return [0, 1].map((h) => {
    const n = 3 + Math.floor(rand() * 3);
    const lo = h === 0 ? 0 : half;
    const hi = (h === 0 ? half : sents.length) - n;
    const start = lo + Math.floor(rand() * Math.max(1, hi - lo));
    return sents.slice(start, start + n).join('');
  });
}

async function ask(passage) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: `${INSTRUCTION}\n\n一節:\n${passage}` }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body),
    });
    if (res.ok) {
      const j = await res.json();
      const text = j.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text).join('') || '';
      try {
        const o = JSON.parse(text);
        const one = Array.isArray(o) ? o[0] : o;
        if (one?.question && one?.evidence && norm(passage).includes(norm(one.evidence))) return { ...one, usage: j.usageMetadata };
      } catch { /* もう一度 */ }
      continue;
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  return null;
}

(async () => {
  const out = [];
  let fail = 0;
  for (const doc of docs) {
    for (const p of passages(doc).slice(0, LITERAL ? 1 : 2)) {
      const got = await ask(p);
      if (!got) { fail++; continue; }
      out.push({ id: `q${String(out.length + 1).padStart(3, '0')}`, doc: doc.id, title: doc.title, passage: p, question: got.question, answer: got.answer, evidence: got.evidence, usage: got.usage });
      if (out.length % 25 === 0) console.log(out.length, '問');
    }
  }
  fs.writeFileSync(path.join(OUT, LITERAL ? 'questions-literal.json' : 'questions.json'), JSON.stringify(out, null, 1));
  const tin = out.reduce((a, q) => a + (q.usage?.promptTokenCount || 0), 0);
  const tout = out.reduce((a, q) => a + (q.usage?.candidatesTokenCount || 0) + (q.usage?.thoughtsTokenCount || 0), 0);
  console.log('できた', out.length, '失敗', fail, '入力', tin, '出力', tout, `$${((tin * 0.75 + tout * 3.75) / 1e6).toFixed(2)}`);
})();
