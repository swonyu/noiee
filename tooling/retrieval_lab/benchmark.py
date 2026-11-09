"""Run only authored fixtures; emit an exclusive source-bound JSON evidence file."""
import argparse
import dataclasses
import hashlib
import json
import math
from pathlib import Path
import platform
import resource
import sqlite3
import subprocess
import sys
import time
import tracemalloc
from datetime import datetime, timezone
from fixtures import corpus, QUERIES
from retrieval import Index

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(fraction*len(values))-1)]

def run(size, backend, repeats):
    documents = corpus(size)
    tracemalloc.start()
    start = time.perf_counter_ns()
    index = Index(documents,backend)
    build_ms = (time.perf_counter_ns()-start)/1e6
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    try:
        details,latencies = [],[]
        docmap = {d.id:d for d in documents}
        for name,query,relevant in QUERIES:
            hits = index.search(query)
            for _ in range(repeats):
                start = time.perf_counter_ns()
                index.search(query)
                latencies.append((time.perf_counter_ns()-start)/1e6)
            ids = [h.document_id for h in hits]
            relevance = set(relevant)
            ranks = [i+1 for i,d in enumerate(ids) if d in relevance]
            provenance = all(h.quote == docmap[h.document_id].text[h.start:h.end] and
                             h.sha256 == digest(docmap[h.document_id].text.encode()) for h in hits)
            details.append({'id':name,'query':query,'relevant_ids':relevant,'returned_ids':ids,
                            'recall_at_3': len(set(ids)&relevance)/len(relevance) if relevance else None,
                            'reciprocal_rank_at_3': 1/min(ranks) if ranks else (0 if relevance else None),
                            'abstained':not hits,'provenance_valid':provenance,
                            'hits':[dataclasses.asdict(h) for h in hits]})
        positives = [q for q in details if q['relevant_ids']]
        negatives = [q for q in details if not q['relevant_ids']]
        return {'backend':backend,'document_count':size,
                'corpus_utf8_bytes':sum(len(d.text.encode()) for d in documents),
                'corpus_sha256':digest(json.dumps([dataclasses.asdict(d) for d in documents],ensure_ascii=False,sort_keys=True).encode()),
                'positive_queries':len(positives),'negative_queries':len(negatives),
                'macro_recall_at_3':sum(q['recall_at_3'] for q in positives)/len(positives),
                'mrr_at_3':sum(q['reciprocal_rank_at_3'] for q in positives)/len(positives),
                'negative_abstention_rate':sum(q['abstained'] for q in negatives)/len(negatives),
                'provenance_valid':all(q['provenance_valid'] for q in details),
                'build_ms_with_tracemalloc':build_ms,'python_build_peak_bytes':peak,
                'sqlite_page_bytes':index.db.execute('PRAGMA page_count').fetchone()[0]*index.db.execute('PRAGMA page_size').fetchone()[0] if index.db else 0,
                'warm_query_samples':len(latencies),'warm_p50_ms':percentile(latencies,.5),
                'warm_p95_ms':percentile(latencies,.95),'queries':details}
    finally:
        index.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--repeats',type=int,default=30)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 1000:
        parser.error('repeats must be 1..1000')
    source_paths = [*sorted(HERE.glob('*.py')), ROOT/'source/Tools.swift',ROOT/'source/attachments.js',ROOT/'source/package-lock.json']
    sources = {str(p.relative_to(ROOT)):digest(p.read_bytes()) for p in source_paths}
    result = {'schema':1,'created_at_utc':datetime.now(timezone.utc).isoformat(),
              'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
              'source_sha256':sources,'python':sys.version,'sqlite':sqlite3.sqlite_version,
              'platform':platform.system()+' '+platform.release()+' '+platform.machine(),
              'scope':'Synthetic development-only retrieval. No app, model, private files, or network.',
              'query_set_sha256':digest(json.dumps(QUERIES,ensure_ascii=False).encode()),
              'runs':[run(size,backend,args.repeats) for size in (18,256,2048) for backend in ('overlap','fts5')]}
    result['process_max_rss_bytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform=='darwin' else 1024)
    # Detect accidental source modifications during benchmark; exclusive output avoids receipt rewrites.
    if any(digest((ROOT/p).read_bytes()) != value for p,value in sources.items()):
        raise RuntimeError('source changed during run')
    with args.output.open('x') as output:
        json.dump(result,output,indent=2,ensure_ascii=False)
        output.write('\n')
    for run_result in result['runs']:
        print(json.dumps({k:v for k,v in run_result.items() if k!='queries'},sort_keys=True))

if __name__ == '__main__':
    main()
