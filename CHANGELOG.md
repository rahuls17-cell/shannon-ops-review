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

- **Segment switch**: All - Computer Bench (Connector, Non-connector) - Company
  Bench. Choosing Computer Bench shows both of its types. Company Bench is
  connector work only (its images are connector harnesses, and a non-connector
  task runs on the Computer bench), so it has no split. The Overview strip has
  three tiles: Computer Bench Connector 838, Computer Bench Non-connector 4,347,
  Company Bench 3,714 pipeline tasks. Old links and saved choices for the
  earlier flat segments, or for Company Bench Connector / Non-connector, open
  the matching segment. (`5f63d80`, `a64b8ca`)
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
- Pipeline tasks split Computer Bench 813 connector / 4,348 non-connector (1
  more of unknown type), Company Bench 3,740; 79 have no bench or type yet.
  (Was 838 / 4,347 / 3,714 / 82 until the delivered join below linked about 60
  more folders to where they were delivered and delivered tasks took their
  type from the delivery.)
- **A non-connector task is always on the Computer bench.** The one "Company
  Bench non-connector" task, `gen-g414-press-release-prohibited-terms-audit`,
  was a misclassification: its Dockerfile starts from the `benchmark-base`
  image, which the image-to-bench rule reads as Company Bench Zeta, but that
  rule is written for connector tasks and this one declares no MCP servers.
  Its 1,368 `gen-g` siblings are all Computer Bench non-connector. The image's
  reading is kept on the row as `benchFromImage`; a check now fails if any
  non-connector task lands on the Company bench. (`truth.js`)

### Company Bench: Aster and Zeta
- **The segment switch splits Company Bench into Aster and Zeta**, on every tab
  - Overview, Delivery, Pipeline, Payouts - the way Computer Bench splits into
  Connector and Non-connector. The Overview strip has four tiles.
- **Which harness**, strongest first: the base image in the task's own
  Dockerfile; then what its delivery manifest records (the image it names, or
  the bench it declares); then, for Zeta only, whether it mounts Zeta's own
  SQL gym (`zeta3-sql-gym`). CompanyBench 1 names no image anywhere and mounts
  it on every task. Aster's gyms are the same kinds a Computer Bench synthetic
  task mounts, so gyms are never used to call a task Aster.
- **The image decides the bench whenever it names one** - Aster or Zeta is
  Company Bench, synthetic or real is Computer Bench connector - and the Drive
  folder a package was filed in decides only when no image was read. In Batch
  5.1, 22 packages in its CompanyBench folder run on a synthetic (19) or real
  (3) image and move to Computer Bench connector, and 27 in its Real Connector
  and Synthetic folders run on a Zeta image and move to Company Bench Zeta. A
  moved Delivery row takes its bench's category and keeps the folder's answer
  as `benchByFolder`.
- **The image rule, checked against the image register Rahul shared** (Zeta V1
  to V4, Aster V5 to V7): an image that says aster is Aster; one that says zeta
  is Zeta, and so are the register's Zeta images that do not say it
  (benchmark-base, company-bench-private, and obi-benchmark at the V3
  pinned-data digest). **Fix:** obi-benchmark@1e2fbc7a (Zeta V3) read as
  Computer Bench synthetic; 29 tasks move to Zeta. The page re-reads every
  cached image with the current rule, so main's older bench index reads right
  on staging too, and a check holds the page and the scanner to the same answer
  on every image.
- **Open:** obi-benchmark@8219115c (30 tasks) is not in the register and the
  labelled reference sheet calls it Computer Bench synthetic, but every one of
  its tasks whose gyms are known (6) mounts the Zeta SQL gym. Those are counted
  as Zeta; the other 24 stay Computer Bench synthetic until it is confirmed.
- Now: pipeline tasks Aster 1,213, Zeta 2,580, Computer Bench connector 767;
  accepted packages Aster 271, Zeta 206; Overview Accepted tasks Aster 163,
  Zeta 176; Delivery Aster 224 (Batches 5.1 to 10.1), Zeta 1,469, Computer
  Bench connector 167. Every Company Bench task is one or the other.
- The Drive reader records `harness` on Company Bench rows.

### Delivery tab
- **Company Bench** = everything in CompanyBench 1-3, plus any package sitting in
  a `CompanyBench` folder inside a Computer Bench batch on Drive - not what the
  manifest's `package_path` says. 5.1, 6.1 and 7.1 file their Company Bench
  connectors there while their manifests call them `Connector/`. Tasks a
  manifest marks as computer bench (the 9 synthetic tasks in CompanyBench 3)
  stay Computer Bench. Now Company Bench 1,688, Computer Bench 172 connector /
  1,371 non-connector. (`23052a7`, `8fd7346`)
- **Category agrees with the bench**: a Company Bench package's category is
  CompanyBench. It used to take the manifest's folder name, so Company Bench
  showed two categories - CompanyBench 1,101 (CompanyBench 3 and the 8.1 to 10.1
  folders) and Connector 587 (CompanyBench 1 and 2, and the 5.1 to 7.1 Company
  Bench connectors, which their manifests file under `Connector/`). Now Company
  Bench is CompanyBench 1,688; Computer Bench connectors are Synthetic 86,
  Connector 39, Real Connector 25, Other 22 (audit connectors labelled
  Other/unclassified).
- **Connector tasks card removed** from the Delivery scorecard; the segment
  switch answers that question.
- **Category x GLM** gains a **Not recorded** column - tasks with no GLM run,
  such as CompanyBench 3's 963 - and a **Sum** column with the row total, so
  each row adds up to its category (CompanyBench 178 + 162 + 191 + 194 + 963 =
  1,688). Not recorded filters to that category with no run; Sum filters to
  the category alone.
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

### Pipeline tab
- **Delivered now covers every batch**, not only the four manifests the
  delivered index was built from. The Delivery join and Accepted packages cards
  sat at 412 / 394 / 18 and 396 / 1,909 because that index reads Batches 1 to
  4.1 only; the VM rebuilds it every refresh, but from the same four manifests,
  so the figures never moved when 5.1 onward went out. The page now joins every
  Delivery row to the accepted folders itself, on load, so a new Drive batch
  counts as soon as the Delivery tab lists it. (`0af9d45`)
- **How a delivery reaches a folder**: the folder its manifest names as the
  source (1 to 4.1, 7.1, 9.1, 10.1), or a folder whose package declares the
  same [task] name, compared exactly (5.1, 6.1 and 8.1 name no folder). A folder
  reached only by name while another folder of the same task was the one sent
  is a re-cut copy; it has gone out as a task, so it is not left to deliver.
- **Accepted packages**: 2,305 = 1,956 already delivered (1,108 by folder, 848
  by task name) + 349 still to deliver. It follows the segment and the filters,
  like the Accepted card beside it, so the two always agree: Computer Bench
  167 + 38 connector, 1,403 + 248 non-connector; Company Bench 386 + 63.
- **Delivery join**: 3,231 delivered (every batch on the Delivery tab) = 1,893
  found in the accepted prefix + 1,338 not found: 18 gone from it (Batches 1
  to 4.1, as before), 1,319 packaged from another source (CompanyBench 1 to 3
  were packaged outside the pipeline), 1 with no source recorded. It follows the
  segment; the list behind it names every one, gone first.
- Pipeline rows take the Delivered / Ready / Not delivered flags from the same
  join (by the Drive batches' declared names; 1 to 4.1 keep the index's
  answer). A folder now linked to its delivery takes that delivery's bench, as
  the bench rule says, so about 60 accepted folders changed bench: Overview
  Pipeline accepted is now Computer Bench 205 + 1,651, Company Bench 449;
  pipeline tasks 813 / 4,346 / 3,740, 4 Computer Bench of unknown type, 78
  unknown.
- **Why 1,956 already delivered is not 1,893 found in the bucket**: different
  units. 1,956 counts accepted folders; the Delivery join counts delivered tasks.
  The 1,956 folders hold 1,880 distinct tasks (by the name their package
  declares) - 76 folders are re-cut copies of a task already counted. From the
  other side, 1,893 found + 3 of the Batch 1 to 4.1 "gone" (their exact archive
  is gone but the same task is still in the prefix) = 1,896 deliveries that
  reach a folder; 16 tasks went out twice (9 in Batch 5.1 again after Batches 1
  to 4.1, 4 in both 5.1 and CompanyBench 2, 3 in both Batch 2 and 6.1), so they
  come to the same 1,896 - 16 = 1,880 tasks. (One pair in 9.1 and 10.1 has
  crossed names - each package's name is the other's declared task - and is
  two deliveries of two tasks.)
- **Delivery & makeup, "What the shown tasks are"**:
  - Connector / Non-connector / Not known now use the segment switch's rule,
    so they split what is shown: under Computer Bench Connector it read 299
    connector + 514 not known, now 813 connector (299 from task.toml, 514 from
    the Dockerfile image). All: 4,553 connector, 4,348 non-connector, 80 not
    known. The Connector filter uses the same rule.
  - **A connector task has no named domain.** The three "named domain" tasks
    under Connector were `code-review-assistant-provenance-attestation`, a
    GitHub connector task whose name starts with `code-`, which the prefix rule
    read as Engineering. The domain is a non-connector naming convention, so it
    is dropped on connector tasks (kept on the row as `domainFromName`); a
    check fails if one comes back.
  - A delivered task takes its type from its Delivery row when task.toml was
    not scanned, ahead of the image. An image left as a build variable
    (`${BASE_IMAGE}:${BASE_TAG}`, 2 tasks) no longer counts as a plain image:
    it had put a CompanyBench 2 connector task on Company Bench as
    non-connector. Pipeline tasks are now 813 / 4,348 / 3,740, 1 Computer Bench
    of unknown type, 79 unknown.
- **In the accepted cohort: "tasks by declared name" is now "distinct accepted
  tasks"**, counted the way the Overview's Accepted tasks card counts them:
  distinct task names across every accepted folder in all three accepted
  prefixes, in the segment. The old tile folded only this cohort's folders by
  the [task] name in each package (2,239); it now reads 2,246 like the
  Overview, and follows the segment (Computer Bench 197 + 1,716, Company Bench
  333). It covers all dates, since the strip has no date range; the cohort-only
  figure is kept in its tooltip. The Overview is unchanged, and a check fails
  if the two rules drift apart.
- **The rest of "In the accepted cohort" follows the segment too.** Packages
  in the cohort, decided since the cut, latest verdict accepted, already
  delivered and the note under them read the bucket index's all-segment totals,
  so only distinct accepted tasks moved with the switch. They are now counted
  from the folders in the segment (each folder row carries its verdict state,
  its runs and whether it has a machine name); under All they equal the index
  (2,320 / 2,293 / 1,810 / 1,956), and packages always equals the Accepted card.
  Computer Bench Connector 207 / 207 / 146 / 167, Non-connector 1,652 / 1,625 /
  1,457 / 1,403, Company Bench 461 / 461 / 207 / 386. The Accepted card's "how
  is this counted" note uses the same figures.
- The Drive reader keeps the source folder a manifest names (`sourcePrefix`,
  `sourceFolder`, `sourceKind`) so the join can read it. (`0af9d45`)

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
- **Paid out, Pending** and the top pending list count each person's tasks in
  the segment instead of their whole balance, so Connector and Non-connector no
  longer read the same. (`2f7b741`)
- **Money is counted task by task at $300, never as a share of a person's
  pay.** The first version split each person's balance by their share of
  tasks, which produced impossible figures ($6,150, $4,050). Now: a ledger task
  marked Paid is paid in its own segment; a Not itemised person (paid for some
  tasks, no record of which) is placed only when all their tasks share one
  segment; paid tasks beyond every task the ledger lists for a person - 3 tasks,
  $900, for ghosh.m1, melat.m and monty.d2 - are tied to no task, so they count
  under All only and the card says so. Computer Bench: paid $5,400 connector
  (18 tasks) + $3,900 non-connector (13) + $900 unplaced = $10,200; pending
  $1,500 (5) + $5,700 (19). Payouts' Settlement by bench and the Overview
  balance chart use the same split, with the unplaced $900 under Unassigned.
- Client accepted and paid are different populations: the payout ledger's 55
  tasks include all 31 client-accepted tasks, but also 18 paid tasks the client
  rejected, so a segment's client-accepted count and its pay are not expected
  to match.

### Data and automation
- The Drive reader follows the regrouped Deliveries folder (`ComputerBench/`,
  `CompanyBench/`), ignores `[Deprecated]`, `[Meta]` and `EKW / SVC`, lists every
  batch folder's zips with the folder they sit in, and matches zips saved under
  their declared or original name. (`9649fd2`, `8fd7346`)
- `tools/build_drive_owners.py` writes `assets/drive-owners.json`; the refresh
  workflows rebuild it with the bucket scan and keep it across their reset onto
  `origin/main`. (`e79b875`)
- **Staging deploys with the default `data_ref=main` now show the current Drive
  batches.** `main` holds a 29 Sep `drive-deliveries.json` (no Batch 10.1, no
  5.1 dedup copy) and no `drive-owners.json`, because nothing on `main` rebuilds
  them yet, and the deploy replaced every asset with `main`'s copy. The deploy
  workflow (shannon-ops-review-staging `60b6d69`) now keeps files `main` lacks
  and, for those two Drive inputs, uses whichever copy has the newer
  `generatedAt`; everything the VM builds still comes from `main`. The banner
  names the real data ref instead of always printing `main@`.
- New checks: `tools/test_drive_owners.py`; `tools/test_drive_deliveries.py`
  covers folder groups, dedup copies, Drive folder benches and types.

### Still open
- The VM steps in `tools/VM-drive-patch.md` (service account and one line in
  `publish.sh`) are not done, so Drive data is the snapshot last committed.
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
