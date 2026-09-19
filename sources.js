(function (root) {
  // PRD C2 / X2. Every figure on this dashboard comes from one of these, and
  // each entry says what it is, why we read it and how it reaches the page.
  // A source with no href is one we cannot link to yet - say so rather than
  // inventing a URL.
  const OPS = 'https://docs.google.com/spreadsheets/d/1LiJ9afqmzc5CkcwV6mclX1in3JUjj4HgIDZSrBanpbM/edit';
  const PPT = 'https://docs.google.com/spreadsheets/d/1tf44mIs_dBAxw6bhbqSrXHef_X1-mTcLD1ygUJxVjVk/edit';

  const SOURCES = [
    {
      id: 'gcs-index',
      name: 'GCS bucket index',
      kind: 'GCS',
      location: 'gs://obi-harbor-pipeline/ (delivery prefixes)',
      href: '',
      hrefNote: 'The bucket has no browsable web URL; it is read through the Harbor VM with a read-only listing.',
      what: 'Names, sizes and modification times of every object under the finalisation cohorts and the trainer records.',
      why: 'So the bucket can be inspected from the dashboard without opening the GCP console, and without downloading anything.',
      how: 'A cron on the Harbor VM lists the prefixes and publishes a sharded JSON index. Metadata only - no object contents are read, and nothing is written to the bucket.',
      views: ['explorer'],
    },

    {
      id: 'gcs-evaluations',
      name: 'GCS trainer evaluation ledgers',
      kind: 'GCS',
      location: 'gs://obi-harbor-pipeline/trainer/',
      href: 'https://console.cloud.google.com/storage/browser/obi-harbor-pipeline/trainer',
      what: 'One ledger per trainer holding every evaluation cycle, plus history snapshots and per-task owner records.',
      why: 'It is the only record of what the pipeline did to a task: status, verdict, retries and who owns it.',
      how: 'A read-only scanner on the Harbor VM walks the prefix and writes assets/gcs-pipeline.json; GitHub Actions pulls it over a restricted SSH command and commits the snapshot.',
      views: ['command', 'pipeline'],
    },
    {
      id: 'gcs-finalisation',
      name: 'GCS finalisation cohorts',
      kind: 'GCS',
      location: 'gs://obi-harbor-pipeline/tasks/',
      href: 'https://console.cloud.google.com/storage/browser/obi-harbor-pipeline/tasks',
      what: 'Seven finalisation cohorts - accepted iterations 1 and 2, QC accepted, two rejected sets, unsubmitted Company Bench, and a Handshake batch.',
      why: 'It is what was actually delivered, as opposed to what the pipeline says happened.',
      how: 'The same VM scan lists each cohort the way it is stored and opens every accepted archive for the declared task name in task.toml. Read-only; nothing is ever written back.',
      views: ['command', 'finalisation'],
    },
    {
      id: 'ops-workbook',
      name: 'Shannon Ops Review (P0) sheet',
      kind: 'Sheets',
      // The live document is titled "Shannon - Ops Tracker"; the xlsx we build
      // from is its export, saved as "Shannon - Ops Review (P0).xlsx".
      liveTitle: 'Shannon - Ops Tracker',
      location: 'paid out, roster, Trainers, New Task Mining Daily Plan, dump, Sheet9',
      href: OPS,
      export: 'Shannon - Ops Review (P0).xlsx',
      tabs: [
        {name: 'paid out', gid: '2138318771', feeds: 'Payouts - what was actually paid'},
        {name: 'roster', gid: '1193334135', feeds: 'Trainer roster and benches'},
        {name: 'Trainers', gid: '1063899001', feeds: 'Trainer records and reporting lines'},
        {name: 'New Task Mining Daily Plan', gid: '482033461', feeds: 'Delivery - the plan-vs-actual heatmap'},
        {name: 'dump', gid: '0', feeds: 'Task dump behind the delivery figures'},
        {name: 'Sheet9', gid: '900644424', feeds: 'Supporting lookup'},
        {name: 'roll up view', gid: '864277116', feeds: 'Not read by this page'},
      ],
      what: 'The operations workbook: who was paid and how much, the trainer roster and reporting lines, and the daily mining plan.',
      why: 'Payments and the roster exist nowhere else - the bucket has no concept of money or of who reports to whom.',
      how: 'Exported to xlsx and built into assets/data.js by tools/build_data.py. Not a live read: the figures move only when the export is re-run.',
      views: ['acceptance', 'payouts', 'delivery'],
    },
    {
      id: 'ppt-workbook',
      name: 'Shannon PPT sheet',
      kind: 'Sheets',
      liveTitle: 'Shannon PPT - Sep 9',
      location: 'task wise, Live Import tracker, CJs, harbor dump',
      href: PPT,
      export: 'Shannon PPT - Sep 9.xlsx',
      tabs: [
        {name: 'task wise', gid: '0', feeds: 'Payouts - the task-level payout list'},
        {name: 'Live Import (Turing PPT tracker)', gid: '1869076687', feeds: 'Payouts - the connector payment requests'},
        {name: 'CJs', gid: '776988023', feeds: 'Payouts - child job to person mapping'},
        {name: 'harbor dump', gid: '1152503697', feeds: 'Pipeline - per-task console verdicts and owners'},
        {name: 'trainer pivot', gid: '1803758163', feeds: 'Not read by this page'},
        {name: 'dump check sheet', gid: '756039395', feeds: 'Not read by this page'},
        {name: 'unattirbute cleanup', gid: '1428396682', feeds: 'Not read by this page'},
      ],
      what: 'The task-level payout list, the payment request tracker, the child job to person mapping, and the console dump behind per-task owners.',
      why: 'It is the only place a payment is tied to a named task and a child job number.',
      how: 'Read by tools/build_payout_ledger.py into assets/payout-ledger.json, which collapses repeated rows so no task can be paid twice, and by tools/build_harbor_console.py for the harbor dump tab.',
      views: ['acceptance', 'payouts', 'pipeline'],
    },
    {
      id: 'harbor-autosync-sheet',
      name: 'Harbor Trainer Tasks - Auto Sync',
      kind: 'Sheets',
      location: 'Trainer Tasks, Task (API), Sync Info',
      href: 'https://docs.google.com/spreadsheets/d/1OabHEPN42W-GcEVp37d6_mbZ93AOZHpkos8JrZjY15c/edit',
      what: 'A cron-refreshed mirror of the Harbor trainer tasks, with its own dashboard tab and staging sheets.',
      why: 'It is the PRD live (cron) Gsheet, and the closest thing to a server-readable copy of the console.',
      how: 'Nothing on this dashboard reads it yet. It is listed so the source is on the record; the console pull is used instead because it is the authoritative feed.',
      views: [],
    },
    {
      id: 'harbor-pipeline-dashboard',
      name: 'Harbor finalisation dashboard',
      kind: 'Harbor',
      location: 'accepted iteration 2 only',
      href: 'https://rahuls17-cell.github.io/harbor-pipeline-dashboard/',
      what: 'A published inventory of the client QC accepted iteration 2 cohort.',
      why: 'An independent count of one cohort, useful as a cross-check on our own scan.',
      how: 'No longer fetched for figures - this page reads the bucket directly. Kept as a link so the two can be compared.',
      views: ['finalisation'],
    },
    {
      id: 'harbor-240',
      name: 'Harbor 240 audit dashboard',
      kind: 'Harbor',
      location: '240-task audit set',
      href: 'https://rahuls17-cell.github.io/harbor-240-dashboard/',
      what: 'The audited 240 tasks with the client review layer from the audit tracker sheet.',
      why: 'It carries the client acceptance verdict: priority Low means the client accepted the task.',
      how: 'Fetched live at page load - it is same origin on Pages - and falls back to assets/client-acceptance.json, a counts-only snapshot.',
      views: ['acceptance'],
    },
  ];

  function sourcesFor(view) {
    return SOURCES.filter(source => source.views.includes(view));
  }

  root.DASHBOARD_SOURCES = SOURCES;
  root.sourcesFor = sourcesFor;
  if (typeof module !== 'undefined') module.exports = {SOURCES, sourcesFor};
})(typeof window === 'undefined' ? globalThis : window);
