# Changelog

What changed on the dashboard, newest first, in words a reader of the page can
use: what a figure now counts, and why it moved. Commits are listed so each
entry can be traced; the automatic "Refresh from the VM" data commits are not.

When you change what a figure means, add a line under **Unreleased**. When
`staging` is promoted to `main`, move those lines under a dated heading.

## Unreleased - on `staging`, not yet on `main`

### Bench and segment: decided by the task, never by the trainer
People work on both benches and the roster moves, so a trainer's roster team no
longer decides Company Bench anywhere on the dashboard.

- **Segment switch is two levels** - Computer Bench and Company Bench, each with
  Connector and Non-connector. Choosing a bench shows both of its types. The
  Overview strip has one tile per bench and type. Old links that named the flat
  Connector / Non-connector segments open the Computer Bench ones. (`5f63d80`)
- **How a task gets its bench**, strongest first: where it was delivered (the
  Drive folder its package sits in); otherwise the base image in its Dockerfile;
  otherwise an unambiguous name lookup. It drives every tab: segment tiles,
  Pipeline, Carried over, the Overview bench cards, finalisation folders,
  evaluations and the payout ledger. (`8fd7346`)
- **People** count in every segment their tasks are in. **Payouts** splits a
  person's paid and pending between benches by the share of their accepted
  ledger tasks on each. (`8fd7346`)
- **Type** of a delivered package is read from its Drive folder too (a
  `Non-Connector` folder means non-connector). A pipeline task with no connector
  flag takes it from its image: Company Bench and synthetic/real Computer Bench
  images are connector harnesses. (`5f63d80`)
- Pipeline tasks now split Computer Bench 838 connector / 4,346 non-connector,
  Company Bench 3,714 / 1; 82 have no bench or type yet.

### Delivery tab
- **Company Bench** = everything in CompanyBench 1-3, plus any package sitting in
  a `CompanyBench` folder inside a Computer Bench batch on Drive - not what the
  manifest's `package_path` says. 5.1, 6.1 and 7.1 file their Company Bench
  connectors there while their manifests call them `Connector/`. Tasks a
  manifest marks as computer bench (the 9 synthetic tasks in CompanyBench 3)
  stay Computer Bench. Now Company Bench 1,688, Computer Bench 172 connector /
  1,371 non-connector. (`23052a7`, `8fd7346`)
- **Batch 5.1 comes from its dedup copy**, `09-25-Batch5.1 (dedup copy
  2026-09-30)`. Its manifest was copied unchanged, so the packages actually in
  the folder decide: 375 of the manifest's 397 (the rest were also delivered in
  CompanyBench 2 and 3). The ones left out are listed on the batch. (`a6637e3`)
- **Trainers for the Drive batches** come from the GCS bucket: the exact archive
  a package was cut from, then the pipeline's trainer records, then QC verdict
  owners. Several people claiming one package makes it Contested, with every
  candidate listed. About 1,330 of 2,819 are attributed; CompanyBench 1 and 3
  were packaged outside the pipeline bucket, so almost none of theirs can be
  named. (`e79b875`)
- **Categories merged** onto the manifest's names: Code -> Engineering, Law ->
  Legal, Other/unclassified and General -> Other, "Non-Connector - X" -> X,
  Company Bench Zeta -> CompanyBench. (`e79b875`)
- **Rows are named by the task's declared name**, not the package file name,
  which for some packages is an id such as `ASTR_101554`; the package name stays
  searchable. (`9649fd2`)
- **Batch 10.1** (144 tasks) added. Connectors that some manifests list as
  objects now show their names instead of `[object Object]`. (`9649fd2`)

### Overview
- **Pipeline accepted** follows the segment and date range, counting the same
  accepted folders as the Pipeline tab's Accepted card: all 2,305, Computer
  Bench 1,856 (206 + 1,650), Company Bench 449 (448 + 1). It used to show the
  bucket's total under every segment. (`dd4708a`)
- **Daily delta** is rebuilt when the segment changes; it used to keep the rows
  it was first built with. (`dd4708a`)
- **Client accepted** under a segment counts the delivery audit's accepted
  tasks in it (the same 31 decisions the Harbor 240 dashboard publishes as a
  count): Computer Bench 3 connector + 28 non-connector. (`2f7b741`)
- **Paid out, Pending** and the top pending list take each person's share in
  the segment instead of their whole balance, so Connector and Non-connector no
  longer read the same: paid $6,150 + $4,050, pending 5 + 19 tasks. (`2f7b741`)

### Data and automation
- The Drive reader follows the regrouped Deliveries folder (`ComputerBench/`,
  `CompanyBench/`), ignores `[Deprecated]`, `[Meta]` and `EKW / SVC`, lists every
  batch folder's zips with the folder they sit in, and matches zips saved under
  their declared or original name. (`9649fd2`, `8fd7346`)
- `tools/build_drive_owners.py` writes `assets/drive-owners.json`; the refresh
  workflows rebuild it with the bucket scan and keep it across their reset onto
  `origin/main`. (`e79b875`)
- New checks: `tools/test_drive_owners.py`; `tools/test_drive_deliveries.py`
  covers folder groups, dedup copies, Drive folder benches and types.

### Still open
- The VM steps in `tools/VM-drive-patch.md` (service account and one line in
  `publish.sh`) are not done, so Drive data is the snapshot last committed.
- The Pipeline tab's delivered / ready-for-delivery join counts only Batches 1
  to 4.1 as delivered.
- The Payouts per-person table still shows a person's whole balance under a
  segment.

## 2026-09-30 - on `main`
- Turing sidebar branding, boot screen, dock pager; Teams moved to Payouts.
  (`fd6d6e6`, varun)
- Delivery: Verified in the bucket card dropped, Trainer column restored.
  (`e9de6f5`, varun)

## v2 - 2026-09-29, staging promoted to production (`c37df20`)
- **Delivery tab reads the Drive manifests**: Batch 5.1 onward and the
  CompanyBench batches added beside the audited Batches 1 to 4.1, Unattributed
  and Pending until known. (`e9795d1`)
- Delivery redesign: batch rail with paging, current-view strip, chart cards,
  GLM in the rail, heat map beside trainers, CSV export, coloured inventory.
  (`9cc3718`, `a676f06`, `016866c`, varun)
- Segment switch, collapsible sidebar, Pipeline filter card, pane decks for the
  Overview, Pipeline and Payouts. (`9def379`, `9ff34b2`, `2df68ad`, varun)
- Payouts: balance veiled until unlocked, "upcoming" in amber instead of
  "owed", lock panel hidden once unlocked. (`de7a375`, `b65397a`, `d7fe3d9`,
  `9e8e905`, `6e136a1`, varun)
- Pipeline: search reaches bucket-only folders, DUP flag on verdict rows, hover
  notes on filters; Overview split counts accepted by pipeline state.
  (`2bb950a`, `581598c`, varun)
- Bench filter: non-connector tasks sit on the Computer bench; the bench scan
  lists the task folder, and a Dockerfile starting with a byte order mark is
  read. (`ec48a85`, `8e55797`, `f4aa465` Rahul Singh, `36709eb` varun)
- Accepted counts bucket folders, as on the live site; tasks by declared name
  sit in the cohort strip. (`2029bae`, reverting `bcaee6c` and `7477ba6`)
