"""Content identity for a task package.

The dashboard's duplicate problem comes from identifying tasks by name. Names
collide - 150 of them span more than one trainer, one is literally `task` and
covers 13 - and they also drift, so the same task can appear twice. Neither
failure is fixable by grouping harder on the name.

This derives identity from what the task actually is: the files that define and
grade it. Two submissions of the same task produce the same fingerprint however
many times it is re-run; a genuine edit produces a different one, which is the
honest answer rather than a silent merge.

What is deliberately excluded matters as much as what is included. `evaluations/`
and the QC report artifacts regenerate on every run, so a digest over the whole
package never matches across reruns - of 365 packages delivered more than once,
every one had a different whole-package digest. Hash the runnable set and only a
real edit moves the key.

Identity comes from each member's path, size and CRC-32, all of which the ZIP
index already stores. No file content is transferred to compute a fingerprint.
"""
import hashlib
import posixpath

# The runnable set: what the task is, and what decides whether it passed.
RUNNABLE_FILES = ('task.toml', 'instruction.md', 'verifier.json', 'golden_trajectory.json')
RUNNABLE_DIRS = ('tests/', 'environment/', 'solution/')

# Recorded runs describe a task; they are not part of it. Anything regenerated
# per run must stay out or reruns never match.
EXCLUDED_DIRS = ('evaluations/', 'client_qc/', '__MACOSX/')
EXCLUDED_NAMES = ('.DS_Store', 'Thumbs.db')

# Bumped when the recipe above changes, so a stored fingerprint always states
# which recipe produced it and stale values are never silently compared.
RECIPE_VERSION = 1


def strip_root(name):
    """Drop the single top-level directory, which is the package name.

    A renamed package holds the same task, so the name must not reach the
    fingerprint - otherwise every rename looks like a new task.
    """
    parts = name.split('/', 1)
    return parts[1] if len(parts) == 2 else name


def is_runnable(relative):
    """True when this path is part of what defines or grades the task."""
    if not relative or relative.endswith('/'):
        return False
    if posixpath.basename(relative) in EXCLUDED_NAMES:
        return False
    if any(relative.startswith(prefix) for prefix in EXCLUDED_DIRS):
        return False
    if relative in RUNNABLE_FILES:
        return True
    return any(relative.startswith(prefix) for prefix in RUNNABLE_DIRS)


def runnable_members(members):
    """The fingerprinted subset, as (relative path, size, crc), sorted by path."""
    rows = []
    for member in members:
        relative = strip_root(member['name'])
        if is_runnable(relative):
            rows.append((relative, int(member['size']), int(member['crc'])))
    rows.sort()
    return rows


def fingerprint(members):
    """Hex digest identifying this task's runnable content, or None if empty.

    None is returned rather than the hash of nothing, so an archive we failed to
    read can never collide with another archive we also failed to read.
    """
    rows = runnable_members(members)
    if not rows:
        return None
    digest = hashlib.sha256()
    digest.update(b'harbor-task-fingerprint/v%d\n' % RECIPE_VERSION)
    for relative, size, crc in rows:
        digest.update(('%s\0%d\0%d\n' % (relative, size, crc)).encode('utf-8'))
    return digest.hexdigest()


def describe(members):
    """Fingerprint plus the counts behind it, for auditing a suspicious match."""
    rows = runnable_members(members)
    return {
        'fingerprint': fingerprint(members),
        'recipeVersion': RECIPE_VERSION,
        'runnableFiles': len(rows),
        'totalFiles': len(members),
        'runnableBytes': sum(size for _, size, _ in rows),
    }
