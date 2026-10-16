/**
 * 論文 007：形ごとの埋め込みを作る（本番と同じ gemini-embedding-001・3072次元・RETRIEVAL_DOCUMENT／RETRIEVAL_QUERY）
 * 使い方: node bench/rag-bench/embed.cjs <形 ...|queries>
 * 出力: out/emb-<形>.f32（Float32 の並び）と out/emb-<形>.ids.json。途中で止まっても続きから
 */
const fs = require('fs');
const path = require('path');
const { build } = require('./variants.cjs');

const DIM = 3072;
const env = fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8');
const KEY = env.match(/^GEMINI_API_KEY="?([^"\n\\]+)/m)[1];
const OUT = path.join(__dirname, 'out');
const URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';

async function embedBatch(texts, taskType) {
  const requests = texts.map((t) => ({ model: 'models/gemini-embedding-001', content: { parts: [{ text: t.slice(0, 2000) }] }, taskType, outputDimensionality: DIM }));
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify({ requests }) });
      if (res.ok) return (await res.json()).embeddings.map((e) => e.values);
      if (res.status !== 429 && res.status < 500) throw new Error(`${res.status} ${await res.text()}`);
    } catch (e) { if (attempt === 7) throw e; }
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error('埋め込みに失敗');
}

async function run(name) {
  const isQ = name.startsWith('queries');
  const items = isQ
    ? JSON.parse(fs.readFileSync(path.join(OUT, name === 'queries' ? 'questions.json' : `questions-${name.slice(8)}.json`), 'utf8')).map((q) => ({ id: q.id, text: q.question }))
    : build(name);
  const taskType = isQ ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
  const binFile = path.join(OUT, `emb-${name}.f32`);
  const idsFile = path.join(OUT, `emb-${name}.ids.json`);
  // 本文の指紋：添える文が変わったら作り直す
  const ids = fs.existsSync(idsFile) ? JSON.parse(fs.readFileSync(idsFile, 'utf8')) : [];
  const same = ids.length && ids.every((x, i) => items[i] && x.id === items[i].id && x.len === items[i].text.length);
  let start = same ? ids.length : 0;
  if (!same) { fs.writeFileSync(binFile, Buffer.alloc(0)); ids.length = 0; }
  for (let i = start; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const vecs = await embedBatch(batch.map((b) => b.text), taskType);
    fs.appendFileSync(binFile, Buffer.from(new Float32Array(vecs.flat()).buffer));
    ids.push(...batch.map((b) => ({ id: b.id, len: b.text.length })));
    fs.writeFileSync(idsFile, JSON.stringify(ids));
    if ((i / 100) % 10 === 0) console.log(name, i + batch.length, '/', items.length);
  }
  console.log(name, 'おわり', items.length);
}

(async () => { for (const n of process.argv.slice(2)) await run(n); })();
