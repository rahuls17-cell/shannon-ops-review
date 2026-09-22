#!/usr/bin/env python3
"""Join the delivered task audit onto the pipeline, once, in one place.

The Delivery tab lists 412 tasks that have already gone out. The Pipeline tab
lists every task the bucket knows about. Answering "has this one already been
delivered?" means joining the two, and the only field they share is the task
name - the pipeline carries no package hash.

That join is done here rather than in the browser, so there is exactly one
implementation of it, it can be tested, and the page only ever does a lookup.

Why a name join is trustworthy here
-----------------------------------
The audit carries a 16-character `sha`, which is the first 16 hex of a full
sha256 recorded in the bucket scan. It reaches only 66 of the 412 packages,
because that scan covers only what sits at the current bar - too little to join
on. It is enough to CHECK the name join, though, and on all 66 rows where both
keys exist they agree. A name match does not invent a delivery.

Names are matched exactly first, then with trailing version and status suffixes
stripped (`-final`, `-v5`, `-fixed`, a bare id number). Normalisation is applied
only after an exact match fails, and it is refused if it would pull in more than
one pipeline name, so it can never merge two distinct tasks into one.

What is NOT matched is reported rather than dropped. 93 audited tasks have no
counterpart in the pipeline's published window; only 2 of them are Accepted, so
the delivered/ready split stands even though the join is incomplete.

    python tools/build_delivered_index.py
"""
import argparse
import collections
import json
import pathlib
import re
from datetime import datetime, timezone

# Suffixes the bucket appends to a task name that the audit's canonical name
# does not carry. Applied repeatedly, so `-fixed-v5` collapses as well.
SUFFIX = re.compile(r'(?:-(?:final|v\d+|\d{4,}|copy|new|fixed|updated))+$')

# Names the platform generates rather than a person choosing them. Kept
# identical to tools/build_manifest_index.py. A row called one of these makes
# no claim about what the work is, so a manifest saying that folder went out
# under a human name has nothing to contradict.
PLACEHOLDER = re.compile(
    r'^(harbor-single-task-|autorun-|content-[0-9a-f]{16,}|task\d*$|task[-_]|'
    r'g\d+_|code-c\d+$|tasks?$)', re.I)

# Strongest first. An audited task is reported under the best key that found it,
# while each row keeps the key that actually reached it.
METHOD_RANK = {
    'name': 0,
    'normalised name': 1,
    'embedded in the verdict identifier': 2,
}


def key(value):
    return str(value or '').strip().lower()


def norm(value):
    name = key(value)
    previous = None
    while name != previous:
        previous = name
        name = SUFFIX.sub('', name)
    return name


def embeds(haystack, name):
    """True when `name` appears in `haystack` as a whole segment.

    284 pipeline rows carry a placeholder name - `harbor-single-task-<junk>` -
    while their family id and their verdict object path still spell the real
    task out. Matching those on name alone leaves them looking undelivered, and
    they then turn up in a manifest as new work when they have already gone out.

    A bare substring test would be too loose, so the match must begin at a
    separator and end at one: `code-c24-audit` matches `family:code-c24-audit-2026...`
    but not `precode-c24-auditor`.
    """
    start = 0
    while True:
        at = haystack.find(name, start)
        if at < 0:
            return False
        before = haystack[at - 1] if at else '/'
        after_at = at + len(name)
        after = haystack[after_at] if after_at < len(haystack) else '/'
        if not before.isalnum() and not after.isalnum():
            return True
        start = at + 1


def build(audit, truth, scan_rows=(), manifest_tasks=()):
    rows = truth['tasks']

    by_exact = collections.defaultdict(list)
    by_norm = collections.defaultdict(list)
    for row in rows:
        by_exact[key(row['name'])].append(row)
        by_norm[norm(row['name'])].append(row)

    # Only rows whose own name could not identify them are searched this way,
    # and only against long audited names, so the loose key cannot override a
    # clean one or fire on something generic.
    named = {key(r['name']) for r in rows} | {norm(r['name']) for r in rows}
    haystacks = [(r, key(r['id']) + '/' + key(r.get('source'))) for r in rows]

    # Where an audited task actually sits when the pipeline has no verdict for
    # it. "Not found here" was being read as "missing", and it is not: the
    # pipeline reads verdicts decided on or after the cut, while the bucket
    # holds every accepted package regardless of when it was decided. Answering
    # this at build time keeps the 47 MB scan out of the browser.
    in_bucket = collections.defaultdict(list)
    for row in scan_rows:
        for spelling in (row.get('declared_short'), row.get('folder'), row.get('declared_name')):
            if spelling:
                in_bucket[key(spelling)].append(row)
                in_bucket[norm(spelling)].append(row)

    def whereabouts(task):
        hits = in_bucket.get(key(task)) or in_bucket.get(norm(task)) or []
        if not hits:
            return {'inBucket': False}
        return {
            'inBucket': True,
            'outcome': sorted({str(h.get('outcome')) for h in hits if h.get('outcome')}),
            'cohorts': sorted({str(h.get('cohortLabel') or h.get('cohort'))
                               for h in hits if h.get('cohortLabel') or h.get('cohort')}),
            'folders': len({h.get('folder') for h in hits if h.get('folder')}),
        }

    delivered = {}          # pipeline id -> how it was matched
    rows_by_id = {r['id']: r for r in rows}
    delivered_task = {}     # pipeline id -> the audited task it belongs to
    matched_audit = []
    unmatched_audit = []
    methods = collections.Counter()

    for entry in audit['rows']:
        name = key(entry['task'])
        # All three methods are applied, not just the first that works. One
        # audited task can appear as several pipeline rows - a clean one and a
        # placeholder-named sibling - and stopping at the first hit leaves the
        # siblings looking undelivered, so they come back round as new work.
        hits = {}
        ambiguous = False

        for row in by_exact.get(name, []):
            hits.setdefault(row['id'], ('name', row))

        # A name with several pipeline spellings collapsing onto it is a
        # collision, not a match, and is deliberately not resolved.
        candidates = by_norm.get(norm(entry['task'])) or []
        if len({key(c['name']) for c in candidates}) > 1:
            ambiguous = True
        else:
            for row in candidates:
                hits.setdefault(row['id'], ('normalised name', row))

        # Long enough that an accidental collision is not credible, and the name
        # must not already belong to some other pipeline task under its own
        # spelling.
        if not ambiguous and len(name) > 14 and name not in named:
            for row, hay in haystacks:
                if embeds(hay, name):
                    hits.setdefault(row['id'], ('embedded in the verdict identifier', row))

        if not hits:
            unmatched_audit.append({
                'task': entry['task'],
                'batch': entry.get('batch'),
                'acceptance': entry.get('acceptance'),
                'reason': 'several pipeline names share this normalised name'
                          if ambiguous
                          else 'no task decided in the pipeline window carries this name',
                **whereabouts(entry['task']),
            })
            continue

        # Every row this audited task found may already belong to an earlier
        # one. how-much-of-my-drive-is-link-only-realdocoutput is the case:
        # its only pipeline row is also embedded-matched by the shorter
        # how-much-of-my-drive-is-link-only, which reached it first. Counting
        # it as matched made the page claim 372 audited tasks were found while
        # only 371 could be pointed at, and a reconciliation that does not
        # reconcile is worse than a gap that is named.
        claimed = [task_id for task_id in hits if task_id not in delivered_task]
        if not claimed:
            first = sorted(delivered_task[task_id] for task_id in hits)[0]
            unmatched_audit.append({
                'task': entry['task'],
                'batch': entry.get('batch'),
                'acceptance': entry.get('acceptance'),
                'reason': f'its only pipeline rows are already claimed by {first}',
                'claimedBy': first,
                **whereabouts(entry['task']),
            })
            continue

        # The audited task is counted under its strongest method; each row keeps
        # the method that actually found it, so a placeholder-named sibling is
        # not reported as a clean name match.
        best = min((m for m, _ in hits.values()), key=METHOD_RANK.get)
        methods[best] += 1
        matched_audit.append(entry['task'])
        for task_id, (method, _) in hits.items():
            delivered[task_id] = method
            # Which audited task this row belongs to. This is the only key
            # that groups a task's rows correctly: name alone misses the 30
            # rows recorded under an alias or a placeholder.
            delivered_task.setdefault(task_id, entry['task'])

    # --- what the delivery manifests place that a name join cannot ----------
    #
    # The manifests were written when each package was cut, so they carry both
    # the human task name and the BUCKET FOLDER it came from. The pipeline
    # records plenty of tasks under machine names - harbor-single-task-7guod6fj,
    # task2, code-C470 - which no name join can ever connect to an audit row.
    # The folder name connects them.
    #
    # The bar for claiming a row is deliberately high, and higher than for the
    # audit join, because this runs against rows that are otherwise about to be
    # delivered. A row whose own name is a VERSION of a delivered name is not
    # claimed: after a rejection that is usually rework which still has to
    # ship, and marking it delivered means it never ships at all. Those are
    # flagged and left in ready for a person to decide.
    manifest_spelling = {}
    for task in manifest_tasks:
        for spelling in (task.get('name'), task.get('taskId'), task.get('folder')):
            if spelling:
                manifest_spelling.setdefault(key(spelling), task)

    manifest_claimed, manifest_flagged = {}, {}
    for row in rows:
        if row['id'] in delivered:
            continue
        if not (row.get('atCurrentBar') and row['state'] in ('accepted', 'legacy accepted')):
            continue
        name = key(row['name'])
        tail = key(row['id']).split(':', 1)[-1]
        stem = re.sub(r'-[0-9a-f]{6,}$', '', tail)
        task = next((manifest_spelling[c] for c in (name, tail, stem)
                     if c in manifest_spelling), None)
        if task is None:
            continue
        note = {'task': task['name'], 'batch': task['batch'], 'sha256': task.get('sha256'),
                'sourceUri': task.get('sourceUri'), 'rowName': row['name']}
        if norm(name) == norm(task['name']) and name != key(task['name']):
            manifest_flagged[row['id']] = dict(note, why='the row name is a version of a '
                'delivered name, so it may be rework that still has to ship')
        elif PLACEHOLDER.match(name) or name == key(task['name']):
            manifest_claimed[row['id']] = dict(note, why='the row carries a machine name; the '
                f"manifest records this folder being packaged as {task['name']} in {task['batch']}")
        else:
            manifest_flagged[row['id']] = dict(note, why='matched through the family id rather '
                'than the row name, so it is reported rather than counted')

    for task_id, note in manifest_claimed.items():
        delivered[task_id] = 'delivery manifest'
        delivered_task.setdefault(task_id, note['task'])
        methods['delivery manifest'] += 1
        # An audited task the name join could not place is placed after all, so
        # it stops being part of the gap the page reports.
        was_unmatched = next((u for u in unmatched_audit if u['task'] == note['task']), None)
        if was_unmatched:
            unmatched_audit.remove(was_unmatched)
            matched_audit.append(note['task'])

    marked = [r for r in rows if r['id'] in delivered]
    accepted = [r for r in rows if r['state'] in ('accepted', 'legacy accepted')]
    at_bar = [r for r in accepted if r.get('atCurrentBar')]
    ready = [r for r in at_bar if r['id'] not in delivered]

    # The loose key is deliberately refused when the audited name already
    # belongs to some pipeline task under its own spelling, because letting it
    # run marks 155 more rows delivered and 8 of those are demonstrably wrong -
    # one row named code-c727-brand-graphic-qa-audit carries an id naming
    # gen-g711-tree-service-invoice-rate-audit. Marking a task delivered when it
    # is not means it is never delivered at all, which is worse than shipping
    # one twice, so the rule stays conservative.
    #
    # That leaves a residue: a ready row whose identifier names an audited task
    # may be a second copy of work that has already gone out. Those are neither
    # marked nor ignored - they are listed, so a manifest can flag them and a
    # person can decide.
    audited_names = sorted({key(e['task']) for e in audit['rows'] if len(key(e['task'])) > 14},
                           key=len, reverse=True)
    suspect = {}
    for row in ready:
        hay = key(row['id'])
        for name in audited_names:
            if embeds(hay, name):
                suspect[row['id']] = name
                break

    # The same warning for a second shape: a ready row whose name is a version
    # of one already delivered - lookalike-...-hand-over-v7 sitting accepted and
    # at the bar while lookalike-...-hand-over is delivered and rejected. That is
    # a rework after a rejection, so it may be new work worth shipping or the
    # same thing handed over again, and only a person can say. Marked, not
    # decided, and not merged: the two rows are genuinely different runs.
    delivered_stems = {}
    for task_id, method in delivered.items():
        if method == 'name':
            delivered_stems.setdefault(norm(rows_by_id[task_id]['name']), task_id)
    for row in ready:
        if row['id'] in suspect:
            continue
        stem = norm(row['name'])
        twin = delivered_stems.get(stem)
        if twin and key(row['name']) != key(rows_by_id[twin]['name']):
            suspect[row['id']] = rows_by_id[twin]['name']

    # The page states these three as a reconciliation - 412 audited, N found
    # here, the rest not - so they have to add up, and every matched task has
    # to be one the page can actually point at.
    assert len(matched_audit) + len(unmatched_audit) == len(audit['rows']), (
        f"{len(matched_audit)} + {len(unmatched_audit)} != {len(audit['rows'])} audited tasks")
    assert set(matched_audit) == set(delivered_task.values()), (
        'an audited task is counted as found but names no pipeline row')

    # The manifest's own warnings sit beside the two the name join produces:
    # all three mean the same thing to a reader cutting a manifest - check this
    # one before you send it.
    for task_id, note in manifest_flagged.items():
        suspect.setdefault(task_id, note['task'])

    return {
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'auditGeneratedAt': audit.get('dataGeneratedAt'),
        'pipelineGeneratedAt': truth.get('generatedAt'),
        'rule': 'a pipeline task is delivered when its name matches an audited '
                'task, exactly or after stripping version and status suffixes',
        'counts': {
            'auditedTasks': len(audit['rows']),
            'auditedMatched': len(matched_audit),
            'auditedUnmatched': len(unmatched_audit),
            'unmatchedAccepted': sum(1 for u in unmatched_audit
                                     if u['acceptance'] == 'Accepted'),
            # Where the unmatched ones actually are. The page states this on
            # the tile, because "not found here" was being read as "missing"
            # and almost none of them are.
            'manifestTasks': len(manifest_tasks),
            'manifestVerified': sum(1 for t in manifest_tasks
                                    if (t.get('bucket') or {}).get('state') == 'hash'),
            'manifestRepackaged': sum(1 for t in manifest_tasks
                                      if (t.get('bucket') or {}).get('state') == 'folder'),
            'manifestAbsent': sum(1 for t in manifest_tasks
                                  if (t.get('bucket') or {}).get('state') == 'absent'),
            'manifestBatches': dict(collections.Counter(t['batch'] for t in manifest_tasks)),
            # The live listing is the check that settles it; the scan-based one
            # above only covers what the pipeline scanner walks.
            'manifestLiveConfirmed': sum(1 for t in manifest_tasks
                                         if (t.get('live') or {}).get('state') in ('object', 'moved')),
            'manifestLiveMissing': sum(1 for t in manifest_tasks
                                       if (t.get('live') or {}).get('state') in ('absent', 'repackaged')),
            'manifestLiveCheckedOn': next((t['live']['checkedOn'] for t in manifest_tasks
                                           if t.get('live')), None),
            # Small enough to travel with the index, and the page needs to be
            # able to name them rather than only count them.
            'manifestMissing': [
                {'task': t['name'], 'batch': t['batch'], 'folder': t.get('folder'),
                 'sourceUri': t.get('sourceUri'),
                 'state': (t.get('live') or {}).get('state')}
                for t in manifest_tasks
                if (t.get('live') or {}).get('state') in ('absent', 'repackaged')],
            'manifestClaimed': len(manifest_claimed),
            'manifestFlagged': len(manifest_flagged),
            'unmatchedInBucket': sum(1 for u in unmatched_audit if u.get('inBucket')),
            'unmatchedClaimed': sum(1 for u in unmatched_audit if u.get('claimedBy')),
            'unmatchedAbsent': sum(1 for u in unmatched_audit
                                   if not u.get('inBucket') and not u.get('claimedBy')),
            'unmatchedCohorts': dict(collections.Counter(
                c for u in unmatched_audit for c in (u.get('cohorts') or [])).most_common()),
            'pipelineTasks': len(rows),
            'deliveredRows': len(marked),
            'deliveredNames': len({key(r['name']) for r in marked}),
            'accepted': len(accepted),
            'acceptedAtCurrentBar': len(at_bar),
            'readyRows': len(ready),
            'readyNames': len({key(r['name']) for r in ready}),
            # Distinct names and distinct tasks are not the same number:
            # -v3 and -v4 of one task are two names and one task. The page
            # folds suffixes when it collapses, so it needs the task count.
            'readyTasks': len({norm(r['name']) for r in ready}),
            'readySuspect': len(suspect),
            'byMethod': dict(methods),
        },
        'delivered': delivered,
        'deliveredTask': delivered_task,
        # Ready rows whose identifier names an audited task. Not a match -
        # a flag for a person to check before the work ships again.
        'suspect': suspect,
        'unmatchedAudit': unmatched_audit,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audit', default='assets/delivery-audit.json')
    ap.add_argument('--truth', default='assets/pipeline-truth.json')
    ap.add_argument('--scan', default='assets/gcs-pipeline.json')
    ap.add_argument('--manifest', default='assets/manifest-index.json')
    ap.add_argument('--out', default='assets/delivered-index.json')
    args = ap.parse_args()

    audit = json.loads(pathlib.Path(args.audit).read_text(encoding='utf-8'))
    truth = json.loads(pathlib.Path(args.truth).read_text(encoding='utf-8'))
    # Optional: without it the unmatched tasks are still listed, just without
    # the "where does it actually sit" column.
    scan_path = pathlib.Path(args.scan)
    scan_rows = ()
    if scan_path.exists():
        blob = json.loads(scan_path.read_text(encoding='utf-8'))
        scan_rows = blob.get('tasks') or (blob.get('finalisation') or {}).get('tasks') or []
    # Optional, and the join still works without it - it just goes back to
    # what a name alone can see.
    manifest_path = pathlib.Path(args.manifest)
    manifest_tasks = (json.loads(manifest_path.read_text(encoding='utf-8'))['tasks']
                      if manifest_path.exists() else [])

    payload = build(audit, truth, scan_rows, manifest_tasks)

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')

    c = payload['counts']
    print(f"audited tasks           : {c['auditedTasks']:>6}")
    print(f"  matched into pipeline : {c['auditedMatched']:>6}   {c['byMethod']}")
    print(f"    of those, in bucket : {c['unmatchedInBucket']:>6}   "
          f"{c['unmatchedCohorts']}")
    print(f"    name collision      : {c['unmatchedClaimed']:>6}")
    print(f"    nowhere at all      : {c['unmatchedAbsent']:>6}")
    print(f"  placed by manifest    : {c['manifestClaimed']:>6}   "
          f"(rows the name join could not see)")
    print(f"  manifest flagged      : {c['manifestFlagged']:>6}   "
          f"(a version of delivered work; left in ready)")
    print(f"  unmatched             : {c['auditedUnmatched']:>6}   "
          f"({c['unmatchedAccepted']} of them Accepted)")
    print(f"pipeline tasks          : {c['pipelineTasks']:>6}")
    print(f"  marked delivered      : {c['deliveredRows']:>6}   "
          f"({c['deliveredNames']} distinct names)")
    print(f"  accepted at the bar   : {c['acceptedAtCurrentBar']:>6}")
    print(f"  possibly already sent : {c['readySuspect']:>6}   (flagged, not excluded)")
    print(f"  ready for delivery    : {c['readyRows']:>6}   "
          f"({c['readyNames']} distinct names)")
    print(f"wrote {out} ({out.stat().st_size/1e3:.0f} KB)")


if __name__ == '__main__':
    main()
