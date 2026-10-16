/**
 * 論文 007：本番の検索（src/lib/search/hybrid-search.ts の hybridSearch）を、そのまま呼んで測る
 * 使い方: npx tsx bench/rag-bench/prod-eval.ts <ラベル> [QSET=literal]
 * - 本番と同じ索引（エックスサーバーの検索データ。つながらなければ同梱の予備）を使う
 * - 本番の索引にある記事から作った問題だけを使う（索引を作った後に書かれた記事の問題は外す）
 * - 物差し：AI に渡す文脈（context）に根拠の文が入っているか、選ばれた3本に正解の記事が入っているか、かかった時間
 * - RAG_RERANK などの切り替えは、環境変数でそのまま本番のプログラムに渡る
 * 出力: out/prod-<ラベル>.json
 */
import fs from 'fs';
import path from 'path';

for (const line of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const OUT = path.join(__dirname, 'out');
const LABEL = process.argv[2] || 'base';
const QSET = process.env.QSET || '';
const norm = (s: string) => s.replace(/[\s。、．，・「」『』（）()【】:：!！?？"'“”]/g, '').toLowerCase();
function hit(text: string, evidence: string): boolean {
  const r = norm(text); const e = norm(evidence);
  if (r.includes(e)) return true;
  const w = Math.ceil(e.length * 0.7);
  for (let i = 0; i + w <= e.length; i++) if (r.includes(e.slice(i, i + w))) return true;
  return false;
}

(async () => {
  const { hybridSearch } = await import('@/lib/search/hybrid-search');
  const { indexLoaderService } = await import('@/services');
  const index = await indexLoaderService.loadRagIndex();
  if (!index) throw new Error('索引が読めない');
  const qs: { id: string; doc: string; question: string; evidence: string; answer: string }[] =
    JSON.parse(fs.readFileSync(path.join(OUT, QSET ? `questions-${QSET}.json` : 'questions.json'), 'utf8'));
  const inIndex = qs.filter((q) => index.posts[q.doc.replace('post_', '')]);
  console.log('問題', qs.length, '→ 本番の索引にある記事の問題', inIndex.length);
  await hybridSearch('ウォームアップ'); // 索引とベクトルの読み込みを先に済ませる（時間に入れない）
  type Row = { q: string; ms: number; relevant: boolean; docInTop3: boolean; evidenceInContext: boolean; contextChars: number; sources: string[]; context: string };
  const rows: Row[] = [];
  for (const q of inIndex) {
    const t0 = Date.now();
    const r = await hybridSearch(q.question);
    const ms = Date.now() - t0;
    const docId = q.doc.replace('post_', '');
    rows.push({ q: q.id, ms, relevant: r.is_relevant, docInTop3: r.sources.some((s) => s.id === docId), evidenceInContext: hit(r.context, q.evidence), contextChars: r.context.length, sources: r.sources.map((s) => s.id), context: r.context });
  }
  fs.writeFileSync(path.join(OUT, `prod-${LABEL}${QSET ? '-' + QSET : ''}.json`), JSON.stringify(rows));
  const avg = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`${LABEL}: 根拠が文脈に入った ${(avg((r) => +r.evidenceInContext) * 100).toFixed(1)}%  正解の記事が3本に ${(avg((r) => +r.docInTop3) * 100).toFixed(1)}%  関係なしと判定 ${(avg((r) => +!r.relevant) * 100).toFixed(1)}%  文脈の長さ ${Math.round(avg((r) => r.contextChars))}字  時間 中央値 ${ms[ms.length >> 1]}ms・90% ${ms[Math.floor(ms.length * 0.9)]}ms`);
  process.exit(0);
})();
