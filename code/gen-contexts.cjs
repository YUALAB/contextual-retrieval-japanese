/**
 * 論文 007：Anthropic の Contextual Retrieval の説明文を、切れ端ごとに作る
 * 使い方: node bench/rag-bench/gen-contexts.cjs <fixed|struct>
 * - 指示文は Anthropic の公開した手順の文をそのまま使い、最後に「文書と同じ言葉で答える」だけを足した（英語の説明文がつくと日本語の BM25 が働かないため）
 * - 作るモデルは小さいもの（gemini-3.5-flash-lite。Anthropic は Claude 3 Haiku）
 * - 文書を先、切れ端を後に置き、同じ文書の切れ端を続けて送る（Gemini の自動キャッシュが効くように）
 * - 途中で止まっても、できた分は out/contexts-<kind>.json に残り、続きから再開する
 */
const fs = require('fs');
const path = require('path');

const KIND = process.argv[2];
const MODEL = process.env.CTX_MODEL || 'gemini-3.5-flash-lite';
const WORKERS = Number(process.env.WORKERS || 6);
const env = fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8');
const KEY = env.match(/^GEMINI_API_KEY="?([^"\n\\]+)/m)[1];
const OUT = path.join(__dirname, 'out');
const docs = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(OUT, 'corpus.json'), 'utf8')).map((d) => [d.id, d]));
const chunks = JSON.parse(fs.readFileSync(path.join(OUT, `chunks-${KIND}.json`), 'utf8'));
const file = path.join(OUT, `contexts-${KIND}.json`);
const done = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

const prompt = (doc, chunk) => `<document>
${doc}
</document>
Here is the chunk we want to situate within the whole document
<chunk>
${chunk}
</chunk>
Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else. Write the context in the same language as the document.`;

async function ask(doc, chunk) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt(doc, chunk) }] }], generationConfig: { temperature: 0, maxOutputTokens: 300 } };
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body),
      });
      if (res.ok) {
        const j = await res.json();
        const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text).join('').trim();
        if (text) return { context: text, usage: j.usageMetadata };
      }
    } catch { /* 通信の失敗はもう一度 */ }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  return null;
}

(async () => {
  // 文書ごとにまとめ、文書の中は順番に送る
  const byDoc = {};
  for (const c of chunks) if (!done[c.id]) (byDoc[c.doc] ||= []).push(c);
  const queue = Object.entries(byDoc).slice(0, Number(process.env.LIMIT_DOCS || 1e9));
  let n = 0;
  let saved = Date.now();
  const save = () => fs.writeFileSync(file, JSON.stringify(done));
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (queue.length) {
      const [docId, list] = queue.shift();
      for (const c of list) {
        const got = await ask(docs[docId].text, c.text);
        if (got) done[c.id] = got;
        if (++n % 200 === 0) console.log(n, '/', chunks.length);
        if (Date.now() - saved > 20000) { save(); saved = Date.now(); }
      }
    }
  }));
  save();
  const u = Object.values(done).map((d) => d.usage || {});
  const tin = u.reduce((a, x) => a + (x.promptTokenCount || 0), 0);
  const cached = u.reduce((a, x) => a + (x.cachedContentTokenCount || 0), 0);
  const tout = u.reduce((a, x) => a + (x.candidatesTokenCount || 0) + (x.thoughtsTokenCount || 0), 0);
  // Flash-Lite：入力 $0.30、キャッシュされた入力はその 1/10、出力 $2.50（百万トークンあたり）
  const cost = ((tin - cached) * 0.30 + cached * 0.03 + tout * 2.50) / 1e6;
  console.log('できた', Object.keys(done).length, '/', chunks.length, '入力', tin, 'うちキャッシュ', cached, '出力', tout, `$${cost.toFixed(2)}`);
})();
