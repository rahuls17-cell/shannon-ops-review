"""Export the T3 (contested trainer) and T4 (handover) duplicate tables as CSV.

Identity is `family_id`, not the task name. Name-keying fused unrelated work that
shared a placeholder name - a task literally called "task" held 51 submissions
from 13 trainers across 32 families - so every name-keyed T3 row was suspect.
family_id is content-derived and populated on every row of the console pull.

T3: families whose submissions name more than one human trainer.
T4: the subset where the LAST submitter differs from the FIRST - work that
    changed hands, so the dashboard credits someone who did not start it.

Only @turing.com addresses count as trainers for the contested test. The console
also carries `dev@localhost`, `harbor-operator-e2e` and an `unknown - no sidecar`
submitter; those are machine or placeholder identities and are listed separately
rather than treated as a second trainer.

Output (both here and in the user's Downloads folder):
    duplicates-t3-contested.csv
    duplicates-t4-handover.csv

These carry real trainer emails. Working files - do not publish them to the Pages
site, which is pseudonymised.
"""
import collections
import csv
import datetime as dt
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOWNLOADS = pathlib.Path(os.path.expanduser('~')) / 'Downloads'
LEGACY_BEFORE = '2026-09-05'
ACCEPTED = {'accepted', 'legacy_accepted'}


def name_key(value):
    v = str(value or '').strip().lower()
    for prefix in ('harbor/', 'obi/'):
        if v.startswith(prefix):
            v = v[len(prefix):]
    return v


def is_trainer(email):
    return '@turing.com' in str(email or '').lower()


def span_hours(first, last):
    try:
        a = dt.datetime.fromisoformat(str(first))
        b = dt.datetime.fromisoformat(str(last))
    except ValueError:
        return ''
    return round((b - a).total_seconds() / 3600, 2)


def main():
    path = ROOT / 'assets' / 'harbor-console-rich.json'
    if not path.exists():
        sys.exit(f'missing {path} - run the rich console pull first')
    payload = json.loads(path.read_text(encoding='utf-8'))
    rows = payload['rows']

    # Group on family_id; fall back to the normalised name only when absent.
    groups = collections.defaultdict(list)
    for row in rows:
        key = row.get('familyId') or f'name:{name_key(row["name"])}'
        groups[key].append(row)
    for g in groups.values():
        g.sort(key=lambda r: str(r['submittedAt']))

    fallbacks = sum(1 for k in groups if k.startswith('name:'))
    print(f'{len(rows):,} submissions -> {len(groups):,} families '
          f'({fallbacks} keyed on name because family_id was blank)')

    t3_rows, t4_rows = [], []
    for key, g in sorted(groups.items()):
        if len(g) < 2:
            continue
        named = [r for r in g if is_trainer(r['trainer'])]
        trainers = sorted({r['trainer'] for r in named})
        if len(trainers) < 2:
            continue

        first, last = named[0], named[-1]
        live = str(g[-1]['submittedAt'])[:10] >= LEGACY_BEFORE
        handover = first['trainer'] != last['trainer']
        per_trainer = collections.Counter(r['trainer'] for r in named)
        machines = sorted({r['trainer'] for r in g
                           if r['trainer'] and not is_trainer(r['trainer'])})
        names = sorted({r['name'] for r in g})

        t3_rows.append({
            'family_id': key,
            'task_names': ' | '.join(names),
            'distinct_names': len(names),
            'scope': 'live' if live else 'legacy',
            'submissions': len(g),
            'trainer_count': len(trainers),
            'trainers': ' | '.join(trainers),
            'submissions_per_trainer': ' | '.join(
                f'{who}={n}' for who, n in per_trainer.most_common()),
            'first_trainer': first['trainer'],
            'first_submitted': first['submittedAt'],
            'last_trainer': last['trainer'],
            'last_submitted': last['submittedAt'],
            'span_hours': span_hours(first['submittedAt'], last['submittedAt']),
            'final_state': g[-1]['state'],
            'states_seen': ' | '.join(sorted({r['state'] for r in g})),
            'credited_to': last['trainer'],
            'handover': 'yes' if handover else 'no',
            'machine_submitters': ' | '.join(machines),
        })

        if not handover:
            continue

        before = [r for r in named if r['trainer'] != last['trainer']
                  and str(r['submittedAt']) < str(last['submittedAt'])]
        t4_rows.append({
            'family_id': key,
            'task_names': ' | '.join(names),
            'scope': 'live' if live else 'legacy',
            'submissions': len(g),
            'first_trainer': first['trainer'],
            'first_submitted': first['submittedAt'],
            'first_state': first['state'],
            'last_trainer': last['trainer'],
            'last_submitted': last['submittedAt'],
            'last_state': last['state'],
            'span_hours': span_hours(first['submittedAt'], last['submittedAt']),
            'trainer_count': len(trainers),
            'trainers': ' | '.join(trainers),
            'attempts_before_handover': len(before),
            'prior_trainers_all_unsuccessful':
                'yes' if before and all(r['state'] not in ACCEPTED for r in before) else 'no',
            'ends_accepted': 'yes' if g[-1]['state'] in ACCEPTED else 'no',
            'credited_to': last['trainer'],
            'uncredited_trainers': ' | '.join(sorted({r['trainer'] for r in before})),
            'machine_submitters': ' | '.join(machines),
        })

    def write(name, data, fields=None, sort_key='family_id'):
        if data:
            data.sort(key=lambda r: (-r['submissions'], r[sort_key]))
            fields = list(data[0])
        elif not fields:
            print(f'{name}: no rows and no header given')
            return
        written = []
        for folder in (ROOT / 'assets', DOWNLOADS):
            folder.mkdir(parents=True, exist_ok=True)
            out = folder / name
            with out.open('w', newline='', encoding='utf-8-sig') as fh:
                writer = csv.DictWriter(fh, fieldnames=fields)
                writer.writeheader()
                writer.writerows(data)
            written.append(out)
        live = sum(1 for r in data if r['scope'] == 'live')
        print(f'{name}: {len(data)} rows ({live} live / {len(data) - live} legacy)')
        for w in written:
            print(f'   -> {w}')

    T3_FIELDS = ['family_id', 'task_names', 'distinct_names', 'scope', 'submissions',
                 'trainer_count', 'trainers', 'submissions_per_trainer', 'first_trainer',
                 'first_submitted', 'last_trainer', 'last_submitted', 'span_hours',
                 'final_state', 'states_seen', 'credited_to', 'handover', 'machine_submitters']
    T4_FIELDS = ['family_id', 'task_names', 'scope', 'submissions', 'first_trainer',
                 'first_submitted', 'first_state', 'last_trainer', 'last_submitted',
                 'last_state', 'span_hours', 'trainer_count', 'trainers',
                 'attempts_before_handover', 'prior_trainers_all_unsuccessful',
                 'ends_accepted', 'credited_to', 'uncredited_trainers', 'machine_submitters']
    write('duplicates-t3-contested.csv', t3_rows, T3_FIELDS)
    write('duplicates-t4-handover.csv', t4_rows, T4_FIELDS)

    # Why T3/T4 are empty: the name key fused unrelated families. This table is
    # the real finding - one name, several distinct pieces of work.
    collisions = []
    by_name = collections.defaultdict(list)
    for row in rows:
        by_name[name_key(row['name'])].append(row)
    for key, g in by_name.items():
        fams = sorted({r['familyId'] for r in g if r['familyId']})
        if len(fams) < 2:
            continue
        g.sort(key=lambda r: str(r['submittedAt']))
        trainers = sorted({r['trainer'] for r in g if is_trainer(r['trainer'])})
        machines = sorted({r['trainer'] for r in g
                           if r['trainer'] and not is_trainer(r['trainer'])})
        per_fam = collections.Counter(r['familyId'] for r in g if r['familyId'])
        collisions.append({
            'task_name': key,
            'scope': 'live' if str(g[-1]['submittedAt'])[:10] >= LEGACY_BEFORE else 'legacy',
            'submissions': len(g),
            'distinct_families': len(fams),
            'distinct_trainers': len(trainers),
            'trainers': ' | '.join(trainers),
            'submissions_per_family': ' | '.join(f'{f[-12:]}={n}' for f, n in per_fam.most_common()),
            'first_submitted': g[0]['submittedAt'],
            'last_submitted': g[-1]['submittedAt'],
            'span_hours': span_hours(g[0]['submittedAt'], g[-1]['submittedAt']),
            'states_seen': ' | '.join(sorted({r['state'] for r in g})),
            'name_keying_credits': g[-1]['trainer'],
            'machine_submitters': ' | '.join(machines),
            'family_ids': ' | '.join(fams),
        })
    write('duplicates-name-collisions.csv', collisions, sort_key='task_name')

    accepted = [r for r in t4_rows if r['ends_accepted'] == 'yes']
    clean = [r for r in accepted if r['prior_trainers_all_unsuccessful'] == 'yes']
    print(f'\nT3 contested families : {len(t3_rows)}')
    print(f'T4 handovers          : {len(t4_rows)}')
    print(f'   ending accepted    : {len(accepted)}')
    print(f'   every earlier submitter failed: {len(clean)}'
          f'  <- credited entirely to the last trainer')


if __name__ == '__main__':
    main()
