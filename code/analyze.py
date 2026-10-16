"""論文 007：形どうしの比べ（同じ問題で対応をとる）
使い方: <scipy のある python> bench/rag-bench/analyze.py [除く問題の JSON]
- 探し漏れ@20 は McNemar（正確検定）、nDCG@10 は対応のある差の平均と、文書ごとにまとめたブートストラップの95%区間
- 主な比べ（Holm で補正）:
  B−A   LLM の説明文（Anthropic）           C−As  見出しで切る（長さをそろえた本番の切り方と）
  D−C   本物の見出しの道筋                   D−E   本物 対 偽の見出し（偽の対照）
  F−D   見出しの上に LLM の説明文            B−C   Anthropic 対 見出しで切るだけ（反論論文の主張）
- 探し方ごと（dense / bm25 / hybrid / hybridProd / bm25ja / hybridJa）に出す
"""
import json, os, sys, random
from collections import defaultdict
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
qs = json.load(open(os.path.join(OUT, 'questions.json')))
drop = set(json.load(open(sys.argv[1]))) if len(sys.argv) > 1 else set()
doc_of = {q['id']: q['doc'] for q in qs}
VARS = ['A', 'As', 'B', 'C', 'D', 'E', 'F']
ev = {v: json.load(open(os.path.join(OUT, f'eval-{v}.json'))) for v in VARS if os.path.exists(os.path.join(OUT, f'eval-{v}.json'))}
MODES = list(next(iter(ev.values())).keys())
CONTRASTS = [('B', 'A'), ('C', 'As'), ('D', 'C'), ('D', 'E'), ('F', 'D'), ('B', 'C')]


def col(v, m, key):
    return {r['q']: r[key] for r in ev[v][m] if r['q'] not in drop}


def boot_ci(diffs, qids, n=4000, seed=7):
    by = defaultdict(list)
    for d, q in zip(diffs, qids):
        by[doc_of[q]].append(d)
    groups = list(by.values())
    rnd = random.Random(seed)
    means = []
    for _ in range(n):
        s = [x for _ in groups for x in rnd.choice(groups)]
        means.append(sum(s) / len(s))
    means.sort()
    return means[int(n * .025)], means[int(n * .975)]


def holm(ps):
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    adj = [0] * len(ps)
    run = 0
    for k, i in enumerate(order):
        run = max(run, min(1, ps[i] * (len(ps) - k)))
        adj[i] = run
    return adj


res = {'n_questions': len([q for q in qs if q['id'] not in drop]), 'means': {}, 'contrasts': {}}
for m in MODES:
    res['means'][m] = {}
    for v in ev:
        mi = col(v, m, 'miss20'); nd = col(v, m, 'ndcg10'); h5 = col(v, m, 'hit5')
        res['means'][m][v] = {'miss20': sum(mi.values()) / len(mi), 'ndcg10': sum(nd.values()) / len(nd), 'hit5': sum(h5.values()) / len(h5)}
    rows = []
    for a, b in CONTRASTS:
        if a not in ev or b not in ev:
            continue
        ma, mb = col(a, m, 'miss20'), col(b, m, 'miss20')
        na, nb = col(a, m, 'ndcg10'), col(b, m, 'ndcg10')
        qids = sorted(ma)
        only_a = sum(1 for q in qids if ma[q] == 0 and mb[q] == 1)  # a だけ見つけた
        only_b = sum(1 for q in qids if ma[q] == 1 and mb[q] == 0)
        p_mc = stats.binomtest(min(only_a, only_b), only_a + only_b).pvalue if only_a + only_b else 1.0
        diffs = [na[q] - nb[q] for q in qids]
        lo, hi = boot_ci(diffs, qids)
        p_nd = stats.wilcoxon(diffs).pvalue if any(diffs) else 1.0
        miss_a, miss_b = sum(ma.values()) / len(qids), sum(mb.values()) / len(qids)
        rows.append({'contrast': f'{a}-{b}', 'miss20_a': miss_a, 'miss20_b': miss_b,
                     'miss_reduction_rel': (miss_b - miss_a) / miss_b if miss_b else 0,
                     'only_a_found': only_a, 'only_b_found': only_b, 'p_mcnemar': p_mc,
                     'ndcg_diff': sum(diffs) / len(diffs), 'ndcg_ci': [lo, hi], 'p_ndcg': p_nd})
    for r, pa, pb in zip(rows, holm([r['p_mcnemar'] for r in rows]), holm([r['p_ndcg'] for r in rows])):
        r['p_mcnemar_holm'], r['p_ndcg_holm'] = pa, pb
    res['contrasts'][m] = rows

print(f"問題 {res['n_questions']}")
for m in MODES:
    print(f'\n== {m}')
    print('  ' + '  '.join(f"{v}: 漏れ {res['means'][m][v]['miss20']*100:4.1f}% nDCG {res['means'][m][v]['ndcg10']:.3f}" for v in ev))
    for r in res['contrasts'][m]:
        print(f"  {r['contrast']:5} 漏れ {r['miss20_a']*100:4.1f}% vs {r['miss20_b']*100:4.1f}%（相対 {r['miss_reduction_rel']*100:+5.1f}%減, 片方だけ {r['only_a_found']}/{r['only_b_found']}, p={r['p_mcnemar']:.3f}, Holm {r['p_mcnemar_holm']:.3f}）"
              f"  nDCG {r['ndcg_diff']:+.3f} [{r['ndcg_ci'][0]:+.3f}, {r['ndcg_ci'][1]:+.3f}] p={r['p_ndcg']:.3f} Holm {r['p_ndcg_holm']:.3f}")
json.dump(res, open(os.path.join(OUT, 'analysis.json'), 'w'), ensure_ascii=False, indent=1)
