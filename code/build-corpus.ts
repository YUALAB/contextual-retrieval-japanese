/**
 * 論文 007：文書を取り直し、切り分け方ごとの切れ端を作る
 * 使い方: npx tsx bench/rag-bench/build-corpus.ts
 * - 文書：aquallc.jp のブログ記事（公開の WordPress API）。見出し（h2〜h4）を残したまま取る
 * - fixed：本番と同じ切り方（題名＋本文を約500文字。indexer.service.ts の chunkText をそのまま写した）
 * - struct：見出しの区切りで切る。500文字を超える節は本番と同じやり方で分け、短い節は同じ大見出しの中でつなぐ
 * 出力: out/corpus.json（文書）、out/chunks-fixed.json、out/chunks-struct.json
 */
import fs from 'fs';
import path from 'path';

const OUT = path.join(__dirname, 'out');
const MAX = 500;

type Section = { path: string[]; text: string };
type Doc = { id: string; title: string; url: string; text: string; sections: Section[] };
export type Chunk = { id: string; doc: string; path: string[]; text: string };

// 本番の extractTextFromHtml と同じ（indexer.service.ts）
function extractText(html: string): string {
  let t = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  return t.replace(/\s+/g, ' ').trim();
}

// 本番の chunkText をそのまま写したもの（indexer.service.ts）
function chunkText(text: string, maxChunkSize = MAX): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\s*\n|。(?=[^」』）】)）])/);
  let currentChunk = '';
  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara || trimmedPara.length < 10) continue;
    if (trimmedPara.length > maxChunkSize) {
      if (currentChunk) { chunks.push(currentChunk.trim()); currentChunk = ''; }
      const sentences = trimmedPara.split(/(?<=[。．！？.!?])\s*/);
      let sentenceChunk = '';
      for (const sentence of sentences) {
        if ((sentenceChunk + sentence).length > maxChunkSize) {
          if (sentenceChunk) chunks.push(sentenceChunk.trim());
          sentenceChunk = sentence;
        } else sentenceChunk += sentence;
      }
      if (sentenceChunk) currentChunk = sentenceChunk;
    } else if ((currentChunk + ' ' + trimmedPara).length > maxChunkSize) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = trimmedPara;
    } else currentChunk += (currentChunk ? ' ' : '') + trimmedPara;
  }
  if (currentChunk && currentChunk.length >= 20) chunks.push(currentChunk.trim());
  return chunks;
}

// HTML を見出しで区切り、各節に「題名 > h2 > h3 > h4」の道筋を付ける
function sectionsOf(title: string, html: string): Section[] {
  const parts = html.split(/(<h[2-4][^>]*>[\s\S]*?<\/h[2-4]>)/i);
  const stack: string[] = [];
  const out: Section[] = [];
  let level = 1;
  for (const part of parts) {
    const m = part.match(/^<h([2-4])[^>]*>([\s\S]*?)<\/h[2-4]>$/i);
    if (m) {
      level = Number(m[1]);
      stack.length = level - 2;
      stack[level - 2] = extractText(m[2]);
      continue;
    }
    const text = extractText(part);
    if (text.length < 10) continue;
    out.push({ path: [title, ...stack.filter(Boolean)], text });
  }
  return out;
}

function structChunks(doc: Doc): Chunk[] {
  // 短い節は、同じ大見出し（h2）の中でつなぐ（つないだ切れ端の道筋は、共通の親）
  const pieces: { path: string[]; text: string }[] = [];
  for (const s of doc.sections) for (const t of chunkText(s.text)) pieces.push({ path: s.path, text: t });
  const merged: { path: string[]; text: string }[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.path[1] === p.path[1] && (last.text + ' ' + p.text).length <= MAX) {
      const common: string[] = [];
      for (let i = 0; i < Math.min(last.path.length, p.path.length) && last.path[i] === p.path[i]; i++) common.push(last.path[i]);
      last.path = common;
      last.text += ' ' + p.text;
    } else merged.push({ ...p });
  }
  return merged.map((p, i) => ({ id: `${doc.id}_s${i}`, doc: doc.id, path: p.path, text: p.text }));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const raw: { id: number; link: string; title: { rendered: string }; content: { rendered: string } }[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://www.aquallc.jp/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=id,link,title,content`);
    if (!res.ok) break;
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    raw.push(...batch);
    if (batch.length < 100) break;
  }
  const docs: Doc[] = [];
  for (const p of raw) {
    const title = extractText(p.title.rendered);
    const content = extractText(p.content.rendered);
    if (content.length < 50) continue; // 本番と同じ
    docs.push({ id: `post_${p.id}`, title, url: p.link, text: `${title}\n\n${content}`, sections: sectionsOf(title, p.content.rendered) });
  }
  const fixed: Chunk[] = docs.flatMap((d) => chunkText(d.text).map((t, i) => ({ id: `${d.id}_f${i}`, doc: d.id, path: [d.title], text: t })));
  const struct: Chunk[] = docs.flatMap(structChunks);
  // 長さをそろえた対照：本番の切り方のまま、平均の長さが struct と同じになる上限を探す
  const mean = (c: Chunk[]) => c.reduce((x, y) => x + y.text.length, 0) / c.length;
  const target = mean(struct);
  let short: Chunk[] = fixed;
  for (let m = MAX; m >= 200; m -= 5) {
    short = docs.flatMap((d) => chunkText(d.text, m).map((t, i) => ({ id: `${d.id}_m${i}`, doc: d.id, path: [d.title], text: t })));
    if (mean(short) <= target) { console.log('長さをそろえた上限', m); break; }
  }
  fs.writeFileSync(path.join(OUT, 'chunks-fixed-short.json'), JSON.stringify(short));
  fs.writeFileSync(path.join(OUT, 'corpus.json'), JSON.stringify(docs));
  fs.writeFileSync(path.join(OUT, 'chunks-fixed.json'), JSON.stringify(fixed));
  fs.writeFileSync(path.join(OUT, 'chunks-struct.json'), JSON.stringify(struct));
  const stat = (c: Chunk[]) => { const L = c.map((x) => x.text.length).sort((a, b) => a - b); return `${c.length}個・平均 ${Math.round(L.reduce((a, b) => a + b, 0) / L.length)}文字・中央値 ${L[L.length >> 1]}`; };
  console.log('文書', docs.length, '・全', docs.reduce((a, d) => a + d.text.length, 0), '文字');
  console.log('fixed ', stat(fixed));
  console.log('struct', stat(struct));
  console.log('short ', stat(short));
  console.log('見出しの深さ', struct.reduce((a, c) => a + (c.path.length - 1), 0) / struct.length);
})();
