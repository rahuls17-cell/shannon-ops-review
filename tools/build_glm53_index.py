"""Index the GLM-5.3 runs per task, for the Pipeline's "GLM-5.3 failed" label.

The runs live in gs://obi-harbor-pipeline/glm53-runs/<run>/: each finished run
folder has a README and one results CSV with a row per task - its status
(complete = 4 clean attempts), its strict passes (a reward of exactly 1) and
the package it ran. The attempts themselves are not read; the results file is
the run's own record of them. The VM downloads the top-level files of each run
folder (tools/vm/scan-glm53.sh) and this script reads them:

    python tools/build_glm53_index.py --runs <dir> --out assets/glm53-index.json

A task is GLM-5.3 failed when it has a complete run and every complete run of
it passed 0 of 4. A task run more than once (a fixed -v2 package, a re-run)
whose runs disagree is not failed: one of its packages was solved. A task with
no complete run - attempts that kept timing out - has no score.
"""
import argparse
import csv
import datetime
import glob
import json
import os
import re

# yogesh-500-final keeps its scores in a comparison file with GLM-5.2.
YOGESH_500 = 'yogesh-500-final'


def read_run(folder):
    name = os.path.basename(folder.rstrip('/\\'))
    if name == YOGESH_500:
        status = {r['task']: r for r in csv.DictReader(open(f'{folder}/glm53-all-500-task-status.csv', encoding='utf-8'))}
        clean = {r['task']: r for r in csv.DictReader(open(f'{folder}/glm53-vs-glm52-clean-results.csv', encoding='utf-8'))}
        for task, s in status.items():
            c = clean.get(task)
            yield {'task': task, 'run': name, 'package': s['delivery_package'],
                   'complete': s['status'] == 'complete' and c is not None,
                   'passes': int(c['glm53_passes']) if c else None}
        return
    found = glob.glob(f'{folder}/*-results.csv')
    if not found:
        return          # a smoke test, not a run
    for r in csv.DictReader(open(found[0], encoding='utf-8')):
        yield {'task': r['task'], 'run': name, 'package': r.get('source_zip') or r['folder'],
               'complete': r['status'] == 'complete',
               'passes': int(r['strict_passes']) if r['strict_passes'] not in ('', None) else None}


def package_key(path):
    """A package path's task folder, the way the bucket names it: no .zip, no -vN."""
    leaf = re.sub(r'\.zip$', '', str(path or '').replace('\\', '/').rstrip('/').split('/')[-1].lower())
    return re.sub(r'(-v\d+)+$', '', leaf)


def build(runs_dir):
    runs = {}
    for folder in sorted(glob.glob(os.path.join(runs_dir, '*', ''))):
        for row in read_run(folder):
            runs.setdefault(row['task'].lower(), []).append(row)
    tasks = {}
    for task, rows in sorted(runs.items()):
        done = [r for r in rows if r['complete'] and r['passes'] is not None]
        tasks[task] = {
            'passes': min((r['passes'] for r in done), default=None),
            'failed': bool(done) and all(r['passes'] == 0 for r in done),
            'disagree': len({r['passes'] == 0 for r in done}) > 1,
            'runs': [{'run': r['run'], 'package': r['package'], 'complete': r['complete'], 'passes': r['passes']}
                     for r in rows],
        }
    # Package names that differ from the task name (numeric connector ids, a
    # re-cut name) find their task through the package folder too.
    alias = {}
    for task, entry in tasks.items():
        for r in entry['runs']:
            key = package_key(r['package'])
            if key and key != task:
                alias[key] = task if alias.get(key, task) == task else None
    alias = {k: v for k, v in alias.items() if v and k not in tasks}
    counts = {
        'tasks': len(tasks),
        'failed': sum(e['failed'] for e in tasks.values()),
        'disagree': sum(e['disagree'] for e in tasks.values()),
        'noCompleteRun': sum(not any(r['complete'] for r in e['runs']) for e in tasks.values()),
        'runs': sorted({r['run'] for e in tasks.values() for r in e['runs']}),
    }
    return {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'source': 'gs://obi-harbor-pipeline/glm53-runs/',
        'rule': 'four GLM-5.3 attempts per task; an attempt passes only at a reward of exactly 1. '
                'Failed: every complete run of the task passed 0 of 4.',
        'counts': counts,
        'tasks': tasks,
        'alias': alias,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', required=True, help='folder holding one sub-folder per GLM-5.3 run')
    ap.add_argument('--out', default='assets/glm53-index.json')
    a = ap.parse_args()
    blob = build(a.runs)
    with open(a.out, 'w', encoding='utf-8') as h:
        json.dump(blob, h, separators=(',', ':'))
    c = blob['counts']
    print(f"{c['tasks']} tasks with GLM-5.3 runs: {c['failed']} failed 0/4, {c['disagree']} with runs that disagree, "
          f"{c['noCompleteRun']} with no complete run; wrote {a.out}")


if __name__ == '__main__':
    main()
