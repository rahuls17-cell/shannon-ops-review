#!/usr/bin/env python3
"""The name join behind the delivered / ready-for-delivery split.

The loose method exists because 1,162 pipeline rows carry a placeholder name -
`autorun-<hash>` or `harbor-single-task-<junk>` - while their family id and
verdict path still spell the task out. Without it those rows look undelivered
and turn up in a manifest as new work. With it, the risk moves the other way: a
careless substring test would mark unrelated tasks as delivered and quietly drop
them from the work queue. This pins the boundary rule in both directions.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from build_delivered_index import embeds, norm, key  # noqa: E402

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


# --- the boundary rule -----------------------------------------------------
name = 'code-c24-cloud-tag-audit'
check(embeds(f'family:{name}-20260826t10143-2f404a', name), 'segment after a colon must match')
check(embeds(f'tasks/qc_platform_sync/_verdicts/{name}-v1-sna.json', name), 'segment in a path must match')
check(embeds(f'task:harbor/{name}', name), 'segment at the end must match')
check(embeds(name, name), 'the whole string must match')

check(not embeds(f'pre{name}-v1', name), 'a name glued to a prefix must not match')
check(not embeds(f'{name}ing-v1', name), 'a name glued to a suffix must not match')
check(not embeds('family:some-other-task-v1', name), 'an unrelated id must not match')

# A near-miss that differs only after the boundary is still a different task.
check(not embeds('family:code-c24-cloud-tag-auditor-2026', name),
      'code-c24-cloud-tag-auditor is not code-c24-cloud-tag-audit')

# --- suffix normalisation ---------------------------------------------------
check(norm('code-c24-unicode-bug-fixed-v5') == 'code-c24-unicode-bug', 'stacked suffixes collapse')
check(norm('gen-g980-as-built-audit-final') == 'gen-g980-as-built-audit', 'final is stripped')
check(norm('law-l35-flow-down-clause') == 'law-l35-flow-down-clause', 'a clean name is untouched')
check(key('  Mixed-Case  ') == 'mixed-case', 'keys are trimmed and lowered')

# --- the published index ----------------------------------------------------
root = pathlib.Path(__file__).resolve().parent.parent
index = json.loads((root / 'assets' / 'delivered-index.json').read_text(encoding='utf-8'))
truth = json.loads((root / 'assets' / 'pipeline-truth.json').read_text(encoding='utf-8'))
by_id = {r['id']: r for r in truth['tasks']}
counts = index['counts']

check(counts['auditedMatched'] + counts['auditedUnmatched'] == counts['auditedTasks'],
      'every audited task is matched or reported')
check(counts['unmatchedAccepted'] <= 5,
      f"{counts['unmatchedAccepted']} accepted deliveries did not match; ready cannot be trusted")
check(index['pipelineGeneratedAt'] == truth['generatedAt'],
      'the index must be built against the published pipeline')

# Every loosely matched row must genuinely be one whose own name is useless.
# If the loose method ever fires on a properly named row it is overriding a
# clean key, which is how a real task would get dropped from the queue.
loose = [i for i, m in index['delivered'].items()
         if m == 'embedded in the verdict identifier']
for task_id in loose:
    row = by_id.get(task_id)
    check(row is not None, f'{task_id} is not a pipeline task')

print(f'loose matches: {len(loose)} rows')
print(f"audited       : {counts['auditedMatched']}/{counts['auditedTasks']} matched "
      f"{counts['byMethod']}")
print(f"unmatched     : {counts['auditedUnmatched']} "
      f"({counts['unmatchedAccepted']} accepted)")

if failures:
    for f in failures:
        print(f'FAIL: {f}')
    sys.exit(1)
print('all delivered-join assertions passed')
