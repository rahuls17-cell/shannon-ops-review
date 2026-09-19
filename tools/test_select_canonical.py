#!/usr/bin/env python3
"""Canonical run selection: progress, then recency, then outcome.

Pins the ordering, because the axes are easy to transpose and the failure is
silent - the pipeline still produces a number, just the wrong one. The case that
motivated this file: a task accepted on 3 September and rejected twice on the
10th reported as accepted, and inherited the 3 September date, which dropped it
out of the reporting window and hid the rejections entirely.

    python3 test_select_canonical.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import select_canonical as S

FAILED = []


def check(name, got, want):
    if got == want:
        print(f'  ok    {name}')
    else:
        print(f'  FAIL  {name}\n          got  {got!r}\n          want {want!r}')
        FAILED.append(name)


def run(decision='', state='', when='', stage='package'):
    return {'decision': decision, 'state': state, 'decidedAt': when, 'stage': stage}


def winner(*runs):
    return max(runs, key=lambda r: S.rank(r)[0])


print('canonical selection')

# The bug this file exists for: outcome must not outrank a later decision.
old_accept = run('accepted', 'accepted', '2026-09-03T21:49:41')
new_reject = run('rejected', 'rejected', '2026-09-10T03:11:35')
check('a later rejection beats an earlier acceptance',
      winner(old_accept, new_reject)['decidedAt'], '2026-09-10T03:11:35')
check('order of the inputs does not change the answer',
      winner(new_reject, old_accept)['decidedAt'], '2026-09-10T03:11:35')

# ...and the mirror case, so the rule is about recency and not about rejections.
old_reject = run('rejected', 'rejected', '2026-09-03T10:00:00')
new_accept = run('accepted', 'accepted', '2026-09-12T10:00:00')
check('a later acceptance beats an earlier rejection',
      winner(old_reject, new_accept)['decidedAt'], '2026-09-12T10:00:00')

# Progress still leads: an undecided rerun must not displace a decided run,
# however recent it is. Undecided runs are placed by their stage.
decided = run('accepted', 'accepted', '2026-09-01T00:00:00')
later_running = run('', 'running', '2026-09-18T00:00:00', stage='gate')
check('a newer undecided run does not displace a decided one',
      winner(decided, later_running)['decidedAt'], '2026-09-01T00:00:00')

later_error = run('', 'error', '2026-09-18T00:00:00', stage='oracle')
check('a newer errored run does not displace a decided one',
      winner(decided, later_error)['decidedAt'], '2026-09-01T00:00:00')

# Among undecided runs, the one that got further wins regardless of date.
early_deep = run('', 'running', '2026-09-01T00:00:00', stage='harbor-check')
late_shallow = run('', 'running', '2026-09-18T00:00:00', stage='intake')
check('further through the plan beats more recent, when neither is decided',
      winner(early_deep, late_shallow)['stage'], 'harbor-check')

# Outcome is the last resort, for runs tied on both progress and instant.
tie_reject = run('rejected', 'rejected', '2026-09-07T14:32:45')
tie_accept = run('accepted', 'accepted', '2026-09-07T14:32:45')
check('outcome breaks an exact timestamp tie',
      winner(tie_reject, tie_accept)['decision'], 'accepted')

# A maximum, so replaying or reordering cannot flip the answer.
runs = [old_accept, new_reject, later_running, decided]
check('idempotent across input order',
      winner(*runs)['decidedAt'], winner(*reversed(runs))['decidedAt'])

# The axes themselves, so a transposition is caught even if the cases above pass.
key, _ = S.rank(run('accepted', 'accepted', '2026-09-10T00:00:00'))
check('rank is (depth, when, outcome)',
      (key[0], key[1], key[2]), (S.MAX_WAVE, '2026-09-10T00:00:00', 3))

print()
if FAILED:
    print(f'FAILED: {len(FAILED)} check(s)')
    raise SystemExit(1)
print('all canonical selection checks passed')
