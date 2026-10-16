/**
 * 論文 007：形ごとに、意味で探す（埋め込み）・言葉で探す（BM25+）・両方（RRF）で探し、成績を測る
 * 使い方: npx tsx bench/rag-bench/evaluate.ts [形 ...]
 * - BM25+ は本番と同じ式と係数（k1=1.2, b=0.75, δ=1）、言葉の切り方も本番の tokenize（辞書＋英単語＋2文字）
 * - RRF は k=60。重みは等しく（Anthropic と同じ）。本番の重み（埋め込み 0.4・BM25 1.6）も別に出す
 * - 正解：切れ端の本文に、根拠の文（evidence）の 70% 以上が続けて入っていれば当たり（切り方によらず同じ物差し）
 * - 物差し：上位20件に当たりが1つもない割合（探し漏れ。Anthropic の物差し）、上位5件・上位10件の当たり、nDCG@10、MRR
 * - 日本語の品詞で切る BM25（kuromoji）も別に測る（bm25ja、hybridJa）
 * 出力: out/eval-<形>.json（問題ごとの順位）と、まとめの表
 */
import fs from 'fs';
import path from 'path';
import { tokenize } from '@/lib/utils/tokenizer';

const OUT = path.join(__dirname, 'out');
const DIM = 3072;
const { build, VARIANTS } = require('./variants.cjs');

type Item = { id: string; doc: string; raw: string; text: string };
type Q = { id: string; doc: string; question: string; evidence: string };

const norm = (s: string) => s.replace(/[\s。、．，・「」『』（）()【】:：!！?？"'“”]/g, '').toLowerCase();

function readVecs(name: string, ids: string[]): Float32Array[] {
  const buf = fs.readFileSync(path.join(OUT, `emb-${name}.f32`));
  const meta: { id: string }[] = JSON.parse(fs.readFileSync(path.join(OUT, `emb-${name}.ids.json`), 'utf8'));
  if (meta.length !== ids.length || meta.some((m, i) => m.id !== ids[i])) throw new Error(`埋め込みがそろっていない: ${name}`);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return ids.map((_, i) => all.subarray(i * DIM, (i + 1) * DIM));
}
const unit = (v: Float32Array) => { let s = 0; for (const x of v) s += x * x; const n = Math.sqrt(s) || 1; return v.map((x) => x / n); };
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// 根拠の 70% 以上が続けて入っているか
function hit(raw: string, evidence: string): boolean {
  const r = norm(raw); const e = norm(evidence);
  if (!e) return false;
  if (r.includes(e)) return true;
  const w = Math.ceil(e.length * 0.7);
  for (let i = 0; i + w <= e.length; i++) if (r.includes(e.slice(i, i + w))) return true;
  return false;
}

function bm25Index(items: Item[], tok: (t: string) => string[] = (t) => tokenize(t, true)) {
  const docs = items.map((it) => { const toks = tok(it.text); const tf = new Map<string, number>(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1); return { tf, len: toks.length }; });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length; const avg = docs.reduce((a, d) => a + d.len, 0) / N;
  const idf = (t: string) => Math.log((N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5) + 1);
  return (query: string) => {
    const qt = [...new Set(tok(query))];
    return docs.map((d) => {
      let s = 0;
      for (const t of qt) { const f = d.tf.get(t) || 0; if (!f) continue; s += idf(t) * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.len / avg))) + 1.0); }
      return s;
    });
  };
}

const rankOf = (scores: number[]) => scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
function rrf(ranks: number[][], weights: number[], n: number): number[] {
  const s = new Array(n).fill(0);
  ranks.forEach((r, k) => r.slice(0, 200).forEach((i, pos) => { s[i] += weights[k] / (60 + pos + 1); }));
  return rankOf(s);
}

function metrics(order: number[], items: Item[], q: Q) {
  const rel = order.slice(0, 20).map((i) => hit(items[i].raw, q.evidence));
  const first = rel.indexOf(true);
  const dcg = rel.slice(0, 10).reduce((a, r, i) => a + (r ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Math.min(10, items.filter((it) => hit(it.raw, q.evidence)).length) || 1;
  const idcg = Array.from({ length: ideal }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return { miss20: first < 0 ? 1 : 0, hit5: first >= 0 && first < 5 ? 1 : 0, hit10: first >= 0 && first < 10 ? 1 : 0, ndcg10: dcg / idcg, rr: first >= 0 ? 1 / (first + 1) : 0, first, top: order.slice(0, 50).map((i) => items[i].id) };
}

const ja = require('./ja/tokenize.cjs');

(async () => {
await ja.init();
// QSET=literal なら、本文の言葉に近い問題集で測る
const QSET = process.env.QSET || '';
const qs: Q[] = JSON.parse(fs.readFileSync(path.join(OUT, QSET ? `questions-${QSET}.json` : 'questions.json'), 'utf8'));
const qVecs = readVecs(QSET ? `queries-${QSET}` : 'queries', qs.map((q) => q.id)).map(unit);
const names: string[] = process.argv.slice(2).length ? process.argv.slice(2) : VARIANTS;
const table: string[] = [];
for (const name of names) {
  const items: Item[] = build(name);
  const vecs = readVecs(name, items.map((i) => i.id)).map(unit);
  const bm = bm25Index(items);
  const bmJa = bm25Index(items, ja.tokenize);
  const modes: Record<string, ReturnType<typeof metrics>[]> = { dense: [], bm25: [], hybrid: [], hybridProd: [], bm25ja: [], hybridJa: [] };
  for (let k = 0; k < qs.length; k++) {
    const dr = rankOf(vecs.map((v) => dot(v, qVecs[k])));
    const br = rankOf(bm(qs[k].question));
    modes.dense.push(metrics(dr, items, qs[k]));
    modes.bm25.push(metrics(br, items, qs[k]));
    modes.hybrid.push(metrics(rrf([dr, br], [1, 1], items.length), items, qs[k]));
    modes.hybridProd.push(metrics(rrf([dr, br], [0.4, 1.6], items.length), items, qs[k]));
    const jr = rankOf(bmJa(qs[k].question));
    modes.bm25ja.push(metrics(jr, items, qs[k]));
    modes.hybridJa.push(metrics(rrf([dr, jr], [1, 1], items.length), items, qs[k]));
  }
  fs.writeFileSync(path.join(OUT, `eval-${name}${QSET ? '-' + QSET : ''}.json`), JSON.stringify(Object.fromEntries(Object.entries(modes).map(([m, rows]) => [m, rows.map((r, k) => ({ q: qs[k].id, ...r }))]))));
  for (const [m, rows] of Object.entries(modes)) {
    const avg = (f: keyof ReturnType<typeof metrics>) => (rows.reduce((a, r) => a + (r[f] as number), 0) / rows.length);
    table.push(`${name.padEnd(3)} ${m.padEnd(10)} 探し漏れ@20 ${(avg('miss20') * 100).toFixed(1).padStart(5)}%  上位5 ${(avg('hit5') * 100).toFixed(1).padStart(5)}%  nDCG@10 ${avg('ndcg10').toFixed(3)}  MRR ${avg('rr').toFixed(3)}`);
  }
  console.log(table.slice(-6).join('\n'));
}
})();
