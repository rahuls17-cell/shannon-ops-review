/* Harbor Console pull — run this ON the console tab, signed in.
 *
 * The console sits behind Google IAP, so nothing server-side can read it: not
 * the dashboard, not the refresh workflow, not the VM (its service account is
 * rejected with "JWT 'email' claim isn't a string"). The only thing holding a
 * valid IAP session is your browser, so the pull has to happen there.
 *
 * Usage: open https://harbor-console-713053229214.us-central1.run.app/trainer-tasks,
 * sign in, open DevTools console, paste this whole file and press enter. It
 * pages the read-only API, builds the asset and downloads
 * harbor-console-live.json. Move that into assets/ and run:
 *
 *     python tools/build_harbor_console.py
 *
 * Read-only: it issues GETs against /api/trainer/tasks and touches nothing else.
 * It never calls retry, sync or any batch mutation.
 */
(async () => {
  const SINCE = '2026-09-05';
  const api = token => `/api/trainer/tasks?page_size=50&page_token=${encodeURIComponent(token)}` +
    '&query=&task_type=all&pipeline_status=all&exclude_auto_batches=true&defer_details=false';

  const rows = [];
  let token = '', pages = 0;
  for (;;) {
    const response = await fetch(api(token), {credentials: 'include'});
    if (!response.ok) throw new Error(`console returned ${response.status} - is the IAP session still valid?`);
    const page = await response.json();
    for (const task of page.items || []) {
      rows.push({
        name: task.name,
        state: task.pipeline_state || '',
        submittedAt: (task.submitted_at || '').slice(0, 10),
        trainer: (task.submitted_by || '').toLowerCase(),
        acceptedFolders: Array.isArray(task.accepted_folders) ? task.accepted_folders.length : (task.accepted_folders || 0),
        failedStage: task.pipeline_failed_stage || '',
        taskType: task.task_type || '',
      });
    }
    pages += 1;
    if (pages % 20 === 0) console.log(`  ${rows.length} tasks…`);
    token = page.next_page_token || '';
    if (!page.has_more || !token) break;
  }

  const tally = list => list.reduce((counts, row) => {
    const key = row.state || '(blank)';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const since = rows.filter(row => row.submittedAt >= SINCE);
  // Only unambiguous owners: where the console shows a task under two
  // trainers, leave it contested rather than picking one.
  const claims = {};
  for (const row of rows) {
    if (!row.trainer.includes('@')) continue;
    const key = row.name.toLowerCase();
    (claims[key] = claims[key] || new Set()).add(row.trainer);
  }
  const owners = {}, contested = [];
  for (const [key, set] of Object.entries(claims)) {
    if (set.size === 1) owners[key] = [...set][0]; else contested.push(key);
  }
  const dates = rows.map(row => row.submittedAt).filter(Boolean).sort();

  const payload = {
    pulledAt: new Date().toISOString(),
    source: location.origin + '/trainer-tasks',
    note: 'Pulled through an authenticated browser session; the console is behind IAP and cannot be read server-side.',
    coverage: {tasks: rows.length, from: dates[0], to: dates.at(-1), since: SINCE, sinceCount: since.length},
    counts: {all: tally(rows), since: tally(since)},
    acceptedFolders: {all: rows.filter(r => r.acceptedFolders > 0).length,
                      since: since.filter(r => r.acceptedFolders > 0).length},
    trainers: {named: rows.filter(r => r.trainer.includes('@')).length,
               distinct: new Set(rows.filter(r => r.trainer.includes('@')).map(r => r.trainer)).size},
    owners,
    contested,
    tasks: rows,
  };

  const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], {type: 'application/json'}));
  const link = Object.assign(document.createElement('a'), {href: url, download: 'harbor-console-live.json'});
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  console.log(`Pulled ${rows.length} tasks over ${pages} pages.`, payload.counts.all);
  return payload.counts;
})();
