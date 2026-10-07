"""Checks for tools/build_trainer_sheet.py: the spellings it matches, and that
delivery-audit.js matches the same ones (tools/test-delivery-audit.cjs holds
the same cases)."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_trainer_sheet import variants, row_keys  # noqa: E402

CASES = {
    'harbor/task_verify_vip_account_8241_interest_fixed.zip': 'verify-vip-account-8241-interest',
    '100601-august-2024-interest-calculation-payout-r-4457f3-v9': 'august-2024-interest-calculation-payout-r',
    'audit-missing-due-dates-on-linked-bill-counterpa-8b8b51-v1': 'audit-missing-due-dates-on-linked-bill-counterpa',
    'seven-urgent-messages-the-filter-buried.zip': 'seven-urgent-messages-the-filter-buried',
}
for raw, expected in CASES.items():
    assert expected in variants(raw), (raw, sorted(variants(raw)))
assert not variants('abc'), 'a fragment this short is not a name'
assert 'tt:100601' in row_keys({'packageName': '100601-august-2024-interest-4457f3-v9'})
assert 'tt:astr_101554' in row_keys({'packageName': 'ASTR_101554'})

asset = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'trainer-sheet.json'
if asset.exists():
    sheet = json.loads(asset.read_text(encoding='utf-8'))
    assert sum(sheet['tabs'].values()) == len(sheet['entries'])
    keep = {'tab', 'task', 'trainer', 'keys'}
    assert all(set(e) <= keep for e in sheet['entries']), 'only names and the trainer leave the sheet'
    assert all('@' in e['trainer'] for e in sheet['entries'] if e.get('trainer'))
print('trainer sheet checks passed: spellings, tracker ids, published asset')
