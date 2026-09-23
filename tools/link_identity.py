#!/usr/bin/env python3
"""Step 3b: join identities that are one task, by family_id OR declared task name.

Why
---
Step 3 keys a run on family_id, falling back to task_id and then name+owner.
family_id is clean but not complete: a task re-submitted after a rejection is
often issued a FRESH family_id, so one task becomes several identities, and the
task_id of a family-keyed row is "<family_id>-vN", which cannot join them
either. Measured on 2026-09-23, that split turned resubmissions into extra
tasks: about 1,280 rejected and 830 undecided identities were repeat attempts
of tasks already counted, and 29 accepted tasks were counted twice.

The name a task declares in its own task.toml does not change between those
submissions (scan_submission_names.py reads and keeps it), so two identities
that declare the same name are joined - under rules that never merge two
different people's work on a name alone. Names are NOT unique per person: 972
declared names were used by more than one trainer.

The rules, applied per declared name, in this order
---------------------------------------------------
1. A person's own identities that declare the name are one task.
2. Two DIFFERENT people are joined only when their OWN runs carry an identical
   instruction text - the same task handed from one trainer to another. Text
   seen only in a service account's run is not evidence about either person.
3. An identity with no person on it (a service account re-running someone's
   task) joins last, and only where it can belong to exactly one person: the
   only person with the name, or the only one sharing its text. Otherwise it is
   left alone and listed for review. Joining it first would let it bridge two
   people who have nothing else in common.
Generic names (`task`, `test`, ...) are not names and join nothing.

Everything held back is written to the review file, never merged silently.

Ids are kept: a joined group takes the id of one of its members (the one with
most runs, a family key before any other), so every index keyed by pipeline id
- delivered, connector, GLM, bench - still finds the task.

    python3 link_identity.py --identities identities.json --names submission-names.json \
        --out identities-linked.json --review link-review.json
"""
import argparse
import collections
import json
import re
from datetime import datetime, timezone
from pathlib import Path

GENERIC = {'task', 'test', 'my-task', 'new-task', 'untitled', 'sample', 'example',
           'default', 'hello-world'}


def declared_key(name):
    """The declared name as a join key, or None if it names nothing in particular."""
    key = re.sub(r'^(harbor|obi)/', '', (name or '').strip().lower())
    return key if key and key not in GENERIC and len(key) >= 6 else None


def is_person(owner):
    owner = (owner or '').lower()
    return owner.endswith('@turing.com') and not owner.startswith('companybench@')


class Groups:
    """Union-find over step-3 identities that keeps, per group, the people on it
    and the instruction texts - all texts, and the ones from people's own runs."""

    def __init__(self, identities):
        self.parent = {i: i for i in identities}
        self.people = collections.defaultdict(set)
        self.texts = collections.defaultdict(set)
        self.own_texts = collections.defaultdict(set)

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def join(self, a, b):
        a, b = self.find(a), self.find(b)
        if a == b:
            return
        keep, gone = (a, b) if a < b else (b, a)
        self.parent[gone] = keep
        for store in (self.people, self.texts, self.own_texts):
            store[keep] |= store.pop(gone, set())


def link(rows, names):
    """Returns {old identity: new identity}, the review lists and counts."""
    for row in rows:
        found = names.get(row.get('submission') or '') or {}
        row['declaredName'] = found.get('name') or ''
        row['_key'] = declared_key(found.get('name'))
        row['_text'] = found.get('instruction')

    groups = Groups({r['identity'] for r in rows})
    for r in rows:
        g = r['identity']
        if is_person(r.get('owner')):
            groups.people[g].add(r['owner'])
            if r['_text']:
                groups.own_texts[g].add(r['_text'])
        if r['_text']:
            groups.texts[g].add(r['_text'])

    by_name = collections.defaultdict(set)
    for r in rows:
        if r['_key']:
            by_name[r['_key']].add(r['identity'])

    held, unattached = [], []
    for name in sorted(by_name):
        roots = lambda: sorted({groups.find(i) for i in by_name[name]})          # noqa: E731
        # 1. each person's own identities
        same = collections.defaultdict(list)
        for g in roots():
            if groups.people[g]:
                same[frozenset(groups.people[g])].append(g)
        for members in same.values():
            for g in members[1:]:
                groups.join(members[0], g)
        # 2. different people, only on identical text from their own runs
        changed = True
        while changed:
            changed = False
            people = [g for g in roots() if groups.people[g]]
            for x in range(len(people)):
                for y in range(x + 1, len(people)):
                    a, b = groups.find(people[x]), groups.find(people[y])
                    if a != b and groups.own_texts[a] & groups.own_texts[b]:
                        groups.join(a, b)
                        changed = True
        people = [g for g in roots() if groups.people[g]]
        if len(people) > 1:
            held.append({'declaredName': name,
                         'people': sorted({p for g in people for p in groups.people[g]}),
                         'identities': len(people),
                         'why': 'different trainers, no identical instruction text between them'})
        # 3. identities with no person on them attach last, to one person at most
        for g in [g for g in roots() if not groups.people[g]]:
            g = groups.find(g)
            if groups.people[g]:
                continue
            people = [p for p in roots() if groups.people[p]]
            if not people:
                others = [o for o in roots() if not groups.people[o] and o != g]
                if others:
                    groups.join(others[0], g)
            elif len(people) == 1:
                groups.join(people[0], g)
            else:
                match = [p for p in people if groups.texts[p] & groups.texts[g]]
                if len(match) == 1:
                    groups.join(match[0], g)
                else:
                    unattached.append({'declaredName': name, 'identity': g,
                                       'candidates': sorted({x for p in people for x in groups.people[p]}),
                                       'why': 'no person on it, and it could belong to more than one'})

    # Keep an existing id per group: most runs, a family key before any other.
    members = collections.defaultdict(list)
    runs = collections.Counter(r['identity'] for r in rows)
    for identity in groups.parent:
        members[groups.find(identity)].append(identity)
    new_id = {}
    for group in members.values():
        keep = sorted(group, key=lambda i: (-runs[i], not i.startswith('family:'), i))[0]
        for identity in group:
            new_id[identity] = keep
    joined = sum(1 for g in members.values() if len(g) > 1)
    return new_id, held, unattached, joined


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--identities', default='identities.json')
    ap.add_argument('--names', default='submission-names.json')
    ap.add_argument('--out', default='identities-linked.json')
    ap.add_argument('--review', default='link-review.json')
    args = ap.parse_args()

    payload = json.loads(Path(args.identities).read_text(encoding='utf-8'))
    rows = payload['rows']
    names_path = Path(args.names)
    names = (json.loads(names_path.read_text(encoding='utf-8'))['submissions']
             if names_path.exists() else {})
    if not names:
        print(f'no declared names at {names_path}; identities pass through unchanged')

    before = len({r['identity'] for r in rows})
    new_id, held, unattached, joined = link(rows, names)
    merged_ids = collections.Counter(new_id[r['identity']] for r in rows)
    group_size = collections.Counter(new_id.values())
    for r in rows:
        old = r['identity']
        r['identityBefore'] = old
        r['identity'] = new_id[old]
        # A group formed here was joined on the package's own declared name, which
        # is read, not guessed - so it counts as merged, like a family.
        if group_size[new_id[old]] > 1:
            r['identityMethod'] = 'declared_name'
            r['identityConfidence'] = 'high'
        r.pop('_key', None)
        r.pop('_text', None)
    after = len(merged_ids)

    named = sum(1 for r in rows if r['declaredName'])
    print(f'{len(rows):,} rows: {before:,} identities -> {after:,} '
          f'({joined:,} groups joined, {before - after:,} identities folded in)')
    print(f'rows with a declared name: {named:,} of {len(rows):,}')
    print(f'held for review: {len(held):,} names shared by different trainers without identical text; '
          f'{len(unattached):,} service-account identities that could belong to more than one person')

    payload['step'] = '3b-linked-identity'
    payload['linkedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    payload['linkCounts'] = {'before': before, 'after': after, 'groupsJoined': joined,
                             'rowsNamed': named, 'held': len(held), 'unattached': len(unattached)}
    Path(args.out).write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    Path(args.review).write_text(json.dumps({
        'generatedAt': payload['linkedAt'],
        'rule': 'family_id OR declared task.toml name; different people only on identical own instruction text',
        'held': held, 'unattached': unattached,
    }, indent=1), encoding='utf-8')
    print(f'wrote {args.out} and {args.review}')


if __name__ == '__main__':
    main()
