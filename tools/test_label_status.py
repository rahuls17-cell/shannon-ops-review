"""Status labelling check. Run: python tools/test_label_status.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from export_gcs_pipeline import label_status, status_of

# The three relabels the dashboard depends on.
assert label_status('done') == 'Submitted'
assert label_status('infrastructure_error') == 'Failed'
assert label_status('error') == 'Failed'

# Everything else keeps its title-cased ledger name.
assert label_status('waiting_for_trainer_edit') == 'Waiting For Trainer Edit'
assert label_status('running') == 'Running'
assert label_status('cancelled') == 'Cancelled'
assert label_status(None) == 'Unknown'
assert label_status('') == 'Unknown'

# A verdict still beats the raw state, and a 'done' cycle with a verdict is an
# outcome - only an unadjudicated one becomes Submitted.
verdict = lambda d: {'status': 'done', 'submission': {'pipeline_verdict': {'decision': d}}}
assert status_of(verdict('accepted')) == 'Accepted'
assert status_of(verdict('rejected')) == 'Rejected'
assert status_of({'status': 'done'}) == 'Submitted'
assert status_of({'status': 'infrastructure_error'}) == 'Failed'

# Conflicting verdicts are still called out rather than resolved.
assert status_of({'status': 'done', 'submission': {
    'status': 'accepted', 'pipeline_verdict': {'decision': 'rejected'}}}) == 'Conflicting verdict'

print('label_status: all checks passed')
