# Changelog

What changed on the dashboard, newest first, in words a reader of the page can
use: what a figure now counts, and why it moved. Commits are listed so each
entry can be traced; the automatic "Refresh from the VM" data commits are not.

When you change what a figure means, add a line under **Unreleased**. When
`staging` is promoted to `main`, move those lines under a dated heading.

## Unreleased - on `staging`, not yet on `main`

### Delivery tab: the hand-reviewed trainer table
- **21 Delivery tasks take their trainer from the ops team's hand review** of rows
  the bucket could not settle (`tools/data/trainer-review.tsv` ->
  `assets/trainer-review.json`, built by `tools/build_trainer_review.py`; task,
  batch, trainer, trainer type, confidence and how it was found - no notes or
  evidence). A review names one task and says why, so it comes before the
  trainer credit sheet and the bucket, on either bench; the bucket's candidates
  or trainer stay on the row. 17 tasks named (Batches 2, 4.1, 5.1 and
  CompanyBench 2; 9 of them were Contested, 8 Unattributed); 4 CompanyBench 2
  tasks reviewed as having no trainer (in-house / DataOS variants, one
  unassigned) stay without one. Source reads "Trainer review".

## v4.3 - 2026-10-09, staging promoted to production

### Delivery tab: Batch 13.1
- **Batch 13.1 is on the Delivery tab**: 158 tasks from "10-09 Batch 13.1" on
  Drive (manifest of 9 Oct, read by hand; same layout as 12.1). Company Bench ·
  Aster 89, Computer Bench Synthetic 69; no non-connector tasks. No earlier row
  changed. Delivered now 3,917: Company Bench 2,091, Computer Bench 1,826.
  GLM-5.3: 70 at 3/4, 39 at 2/4, 37 at 1/4, 12 at 0/4. Trainers: 128 from the
  bucket, 25 contested, 5 unattributed. All 158 match an accepted folder, so the
  Pipeline marks them delivered (DL). Like 12.1, the manifest lists no
  connectors ("connectors not read" on the Aster tasks).

## v4.2 - 2026-10-09, staging promoted to production

### Delivery tab: Batch 12.1
- **Batch 12.1 is on the Delivery tab**: 283 tasks from "10-08 Batch 12.1" on
  Drive (manifest of 8 Oct, read by hand). Only 12.1 was added - "10-08 Batch
  11.2", "10-07 Calibration-Batch" and the fixed folders beside it are left out.
  Company Bench · Aster 145, Computer Bench Synthetic 99 and Non-connector 39.
  Its manifest has no bench_type and puts the class, with its count, under the
  bench group ("Computer Bench (NC 39 RC 0 S 99)/Synthetic 99/Easier 34/x.zip"):
  the reader takes the class from that folder, and from `tracker_family` where
  a Computer Bench package has no class folder. No earlier row changed.
  Delivered now 3,759: Company Bench 2,002, Computer Bench 1,757. GLM-5.3: 116 at
  3/4, 76 at 2/4, 61 at 1/4, 30 at 0/4. Trainers: 225 from the bucket, 1 from the
  trainer credit sheet, 56 contested, 1 unattributed. The Pipeline marks all 283
  delivered (DL). The manifest lists no connectors, so its 145 Aster tasks read
  "connectors not read" (single or multi-connector unknown).
- **Batch 12.1's non-connector tasks take a domain from their name.** Its layout
  stops at difficulty (`Non-Connector 39/Harder 20/x.zip`) and the manifest names
  no domain, so the 39 read plain "Non-Connector". Where a manifest gives none,
  the domain now comes from the task-name prefix, as the delivery team's domain
  folders do in every earlier batch (all but 2 of about 1,350): code- and tech-
  Engineering, fin- Finance, health- Health, law- Legal, anything else Other.
  12.1: Other 23, Engineering 12, Health 3, Finance 1. No earlier row changed.

## v4.1 - 2026-10-07, staging promoted to production

### Pipeline tab: Batch 11.1 counts as delivered
- **A batch delivered after the GLM 5.3 cutoff now reaches the Pipeline.** The
  Pipeline's delivery join (the DL tag, the Delivered / Ready filter, the cohort's
  delivered split) and the bench, harness and connector count a delivered task
  gives its pipeline row read the GLM 5.3 cutoff rows only, so Batch 11.1 - in
  the Current Drive data alone - matched all 274 of its accepted folders and
  marked none delivered. They now read the cutoff rows plus every batch only the
  Current Drive data has (`deliveredRows`), so later batches follow on their own.
  Batch 11.1: 274 of 274 marked delivered (270 by the task the package declares,
  4 by the folder the manifest names). Delivered filter today: Delivered 1,911 ->
  2,176, Ready 956 -> 697, Not delivered 5,153 -> 4,891.

## v4 - 2026-10-07, staging promoted to production

### Delivery tab
- **Export manifest.json**, right below Export CSV. It writes the packages the
  tab is showing - all batches, or the batch selected in Batch scope, with the
  segment and filters applied as for the CSV - as a delivery manifest in the
  Drive manifests' own shape (`harbor/delivery-manifest/v4`): one entry per
  package, restated from the batch manifest that listed it (task id and name,
  package path, difficulty, GLM-5.3 successes, connectors, bench, Aster or Zeta,
  source, sha256, size), in batch order and then manifest order, with a summary
  by batch, bench, class and band. Nothing is deduplicated - a task delivered in
  two batches is two entries - and no trainer is written. All batches today:
  3,202 packages, Company Bench 1,673, Computer Bench 1,529. To carry the full
  checksum and size, each Drive row now also keeps `sha256`, `sizeBytes`,
  `sourceUri`, `taskName`, `benchType` and `glmModel` from its manifest
  (`drive-deliveries.json` 2.7 to 3.8 MB; no other value changed). The older
  manifests record no source URI or bench type, so those entries leave them null.
- **Export manifest.json and Export CSV keep the file's link for a minute** instead
  of releasing it the moment the download starts: the all-batches manifest is
  4 MB, and Chrome can drop a download whose link is revoked before it has read it.

### Bench from the image: the Shannon Connector Image Tracker
- **The image rule follows the Shannon Connector Image Tracker** (Drive,
  anuj.jain; read 7 Oct), in the scanner (`tools/read_task_toml.py`) and on the
  page (`truth.js`), where it disagreed:
  - `obi-benchmark@sha256:8219115c` (zeta-newdbs-20260918) is **Zeta**, not
    Computer Bench synthetic - 30 verdict rows, 4 accepted;
  - real-data-v4 (`connectors-harness@sha256:f976065b`, or the tag alone) is
    **Aster**, not Computer Bench - 40 accepted folders;
  - the synthetic 12-connector and old synthetic images hosted on Docker Hub as
    `company-bench-private` (`dcf57c1b`, `f468ad6d`, `bcae80df`, `e3ab159e`,
    `52ec261e`, `1cb77ee0`) are **Computer Bench synthetic**, not Zeta - 79
    accepted folders on `dcf57c1b`.
  Accepted folders by segment, today's data: Aster 550 -> 590, Zeta 286 -> 207,
  Computer Bench connector 269 -> 308, non-connector 1,687 unchanged. The
  tracker overrides the older "350 tasks accepted" reference on these images;
  the test says so rather than the reference being edited.
- Delivery tab: 7 Company Bench tasks in Batch 2 whose manifest lists real-data-v4
  for their connectors now read Aster (no harness before). The Drive folders
  still decide the bench there: Batch 10.1's 38 tasks on the Aster image stay
  Computer Bench ("Real ComputerBench"), and Batch 2's 2 tasks on synthetic
  images stay Company Bench ("Batch 2 - CompanyBench").

### Delivery tab: Batch 11.1
- **Batch 11.1 is on the Delivery tab**: 274 tasks from "10-06 Batch 11.1" on
  Drive (manifest of 7 Oct, read by hand - the Drive refresh is off the cron).
  Its packages are grouped by bench, not class: "Aster 180" -> Company Bench ·
  Aster (180), "Company Bench 4" -> Company Bench · Zeta (4), "Computer Bench
  (NC 0 RC 0 S 90)" -> Computer Bench, Synthetic by each package's bench_type
  (90). The reader learns those folder names; no earlier row changed. Delivered
  now 3,476: Company Bench 1,857, Computer Bench 1,619. GLM-5.3: 118 at 3/4, 79 at
  2/4, 53 at 1/4, 24 at 0/4. Trainers from the bucket: 240 named (3 by the
  trainer credit sheet), 19 contested, 15 unattributed. 4 Aster packages swapped
  in on 7 Oct list no connectors in the manifest ("connectors not read").
- Drive folder titles in the data are the current ones (ComputerBench (NC 1363
  RC 72 S 94), 09-16-Batch4.1 (NC 196 ...), 09-25-Batch5.1 (NC 219 ...)).

### Delivery tab: trainers from the trainer credit sheet
- **Tasks the bucket cannot settle take their trainer from the ops team's
  "CompanyBench Trainer Credit Analysis Report"** (Drive, jagadeesh.g; tabs Zeta
  - Trainer Mapping, Astr - Trainer Mapping, Non-Company Bench Mapping, 574
  rows). Used only where the bucket's owner index names no one (Unattributed) or
  several people (Contested), and only when the sheet names exactly one trainer
  for the task; a trainer the bucket names is kept. Matched by Task Tracker id
  and by every spelling the manifests use (`task_` prefix, underscores,
  `-<hash>-vN` tails, `100601-` tracker prefixes). Source reads "Trainer credit
  sheet"; a settled contested row keeps the bucket's candidates. Today: 106
  tasks filled - Company Bench 32 unattributed and 56 contested, Computer Bench
  11 and 7. Applied by the page from `assets/trainer-sheet.json` (built by
  `tools/build_trainer_sheet.py` from a downloaded copy; only task names and the
  trainer's email are kept), so the VM's owner rebuilds do not undo it.
- **Still without a trainer, Company Bench:** 1,248 not in the sheet (CompanyBench
  1: 247, CompanyBench 3: 961 - the sheet covers neither - and 40 across Batches
  2 to 8.1 and CompanyBench 2), 2 whose sheet row names no trainer.
- **For Company Bench the sheet also replaces a trainer the bucket names** (a
  re-run by a lead or service account, a second trainer's rework): 31 tasks, e.g.
  Batch 2 `a-fortnight-nobody-was-watching` saurabh.p5 -> pawan.g3. The bucket's
  trainer stays on the row (`bucketTrainer`). A Computer Bench trainer the bucket
  names is kept (6 disagreements). Trainer credit sheet now decides 137 tasks.

### Pipeline tab
- **Exclude a previous manifest reads delivery manifests**: a Drive batch
  manifest or the Delivery tab's Export manifest.json (`harbor/delivery-manifest`)
  was refused with "no tasks in that file", because only the Pipeline's own
  manifest shape was read. A delivery entry now excludes by its bucket folder
  (`source_folder`, or the folder in `source_uri`), its task id and package file,
  and its declared task name, matched against a ready row's name and the task its
  package declares. The Delivery export now writes `source_prefix` and
  `source_folder` too. All batches today: 30 of the 742 ready tasks excluded, each
  a re-cut of a task a Drive batch already delivered (the page already flagged
  them as possibly delivered).
- **A loaded manifest now takes its tasks out of the Ready for delivery list.**
  Load a previous manifest (the Delivery tab's all-batches export, a Drive batch
  manifest, or one the Pipeline wrote) and every task it already names - by
  folder, task id, package file or declared name, a later version included -
  leaves the table, its counts and the CSV; Drop exclusions brings them back.
  Create manifest.json then writes exactly what is left. Today: 742 ready, 712
  after loading the all-batches export, written as 708 tasks.
- **One entry per task, by the name its package declares.** A task re-cut under
  a new name after review was two manifest entries; it is now one, the most
  recent decided run speaking for it and the other listed in `standsFor`
  (4 such today). The manifest records the file it excluded (`excludedFrom`)
  and counts the tasks taken out of the list.
- **Only the files you load exclude.** Create manifest.json no longer adds the
  tasks it just wrote to the exclusions on its own - which emptied the list
  after a download and made Drop exclusions look like it undid the file - so the
  list keeps showing what went into the manifest. For a second round, load the
  file just written. Several files stack; Drop exclusions clears them all.
- **Every count on the Tasks pane follows the loaded file**: the filter bar
  ("712 of 9,348 tasks") and the State, Ready, Gate and Delivery chips still
  counted all ready tasks (894 on staging) while the table showed the rest.
- **Fix:** an excluded folder key keeps its suffix. A folder named `...-v5` or
  `...-20260918` had the suffix stripped before matching, so it was never
  excluded, even by a manifest the Pipeline wrote itself.

### Tests
- `test-cohort.cjs`: since 5 Oct the connector scan reads all 2,590 accepted
  packages, so no folder needs the direct task.toml read the check expected
  (709 before, 0 now). It now passes when no folder is left unknown.
- `test_duplicate_sample.py`: the console pull lists 51 submissions twice (same
  task id, run and timestamp); one, `a-fortnight-nobody-was-watching` run
  `delivery-11abc37e`, as both error and accepted, which the check read as two
  submissions tied on time. Repeats are folded into one first, a decided state
  outranking error or running: 0 ties left, and `duplicate-sample.json` is
  rewritten (1,350 to 1,333 duplicate task keys).

## v3 - 2026-10-06, staging promoted to production

### Drive: the 3 Oct layout, and a switch back to the GLM 5.3 cutoff
- **The Drive switch is hidden.** The Delivery tab shows Current only: the
  Drive card above Batch scope is gone, and neither `?drive=glm53` nor a view
  saved earlier in the browser brings the GLM 5.3 cutoff back. The cutoff files
  (`assets/drive-deliveries-glm53-cutoff.json`, `assets/drive-owners-glm53-cutoff.json`)
  and the switch's code stay in the repo; `DRIVE_SWITCH_SHOWN` in app.js turns
  it back on. The other tabs read as before.
- **The Drive switch belongs to the Delivery tab.** It sits at the top of the
  tab's left rail, above Batch scope, and changes that tab only. Every other tab
  - the Overview (Client accepted under a segment), the Pipeline's delivery
  join, the bench a delivered task gives a pipeline row - keeps reading the GLM
  5.3 cutoff rows, as it did before the Drive was reorganised, whichever view
  the Delivery tab shows. It is no longer in the top bar or the filter chips.
- **A Drive switch: Current (default) or GLM 5.3 cutoff.** The
  Deliveries folder was reorganised on 3 Oct. GLM 5.3 cutoff is the dashboard
  exactly as it stood before, read on 1 Oct and kept unchanged
  (`assets/drive-deliveries-glm53-cutoff.json`, `drive-owners-glm53-cutoff.json`):
  3,231 delivered tasks, Company Bench 1,696. Current reads the folder as it is
  now. The choice is kept in the link (`?drive=glm53`).
- **The reader follows the new layout** (`tools/build_drive_deliveries.py`):
  - group folders nest two levels: `CompanyBench 1673/CompanyBench - From
    Pipeline 350/Batch 9.1 - CompanyBench 89`;
  - a "Batch N - CompanyBench" folder with no manifest is Batch N's Company Bench
    share: its zips count for Batch N, filed under CompanyBench/, matched
    against Batch N's manifest. For the audited Batches 1 to 4.1 the share is
    published as `auditedCompany` and the page puts those audited tasks on the
    Company bench (34: Batch 1 12, Batch 2 12, Batch 3 1, Batch 4.1 9);
  - a share zip its batch's manifest does not list counts for the CompanyBench
    batch whose manifest does: five CompanyBench 3 packages filed under "Batch 3
    - CompanyBench";
  - a package is published only when its zip is on Drive (the cleanup took
    duplicates out of folders and left the manifests alone); the rest are
    listed as left out;
  - the class a Drive folder names wins over the manifest's folder: Batch
    10.1's CompanyBench folder is now "Real ComputerBench (NC 0 RC 37 S 0)";
  - Batches 5.1, 6.1 and 7.1 were re-cut on 1 Oct with new manifests (5.1 now
    the dedup content, 375; 6.1 271; 7.1 169).
- **Read without a Drive token**, through the Drive connector, on 5 Oct; the
  live reader can also use a gcloud application-default sign-in with the
  drive.readonly scope now. Folder contents were listed where something moved
  (CompanyBench 1 and 3, the nine shares, 10.1's Real ComputerBench); every
  other batch's folder counts match its manifest.
- **Current is the Drive and nothing else.** Every delivered task is a package
  in a Drive folder: Batches 1 to 4.1 too, read from their Drive folders and
  manifests (`ComputerBench/09-08-Batch1` and so on, plus their Company Bench
  shares), not from the delivery audit. Bench, Aster or Zeta and connector count
  come from where a package is filed and what its manifest records - including
  a connector's own image when the manifest lists one (Batch 2) - never from the
  Dockerfile image in the bucket. The Drive holds no client decision, so every
  task reads Pending. Trainer names still come from the bucket's owner join
  (`drive-owners.json`), as before.
- The reader reads the older manifest layouts Batches 1 to 4.1 carry: a wrapper
  folder first (`finalization_qc_accepted_zipped/`, `computerbench-batch-5/`), the
  difficulty before the class, connectors under `connector.services`, as
  `{name, image}`, or as one string joined by `|` (Batch 6.1).
- **Current, today:** 3,202 delivered tasks across 13 batches. Company Bench
  1,673 - the Drive's own total (CompanyBench 1 252 + 2 110 + 3 961 + the From
  Pipeline shares 350): Aster 181, Zeta 1,358, and 134 whose harness the Drive
  does not record (115 in Batch 5.1, whose manifest lists only "harbor" for its
  connector packages). Computer Bench 1,529: the Drive's folder titles say 1,782
  because Batch 4.1 keeps its original "Non-Connector (NC 192)" folder beside
  "Non-Connector-fixed (NC 196)" - every one of the 192 is also in the fixed
  folder, and the manifest lists the 196 - and Batch 5.1's "Engineering 112"
  folder holds 51 zips. 5 of CompanyBench 3's 971 manifest packages are on
  Drive only in `[Deprecated]/CompanyBench 1678 - removed duplicates`.
- **Fix: 9 CompanyBench 3 tasks labelled Computer Bench synthetic are Zeta.**
  The manifest files them under `Synthetic/` with bench_type computer bench
  synth, from their image `connectors-rl-gym/obi-benchmark@sha256:e76ff56a...` -
  the same digest as `company-bench-private:zeta-newdbs2-20260918`, Zeta V4 in
  the image register, which lists V4 by its tag only. All 9 mount the full Zeta
  gym set, and the Drive files the 5 still delivered under Company Bench. The V4
  digest joins the known Zeta images (scanner and page), and for a CompanyBench
  batch the image a manifest records (image_ref, or the image in bench_basis)
  decides the bench ahead of the label written from it. No pipeline task runs on
  that image under the obi-benchmark name, so the Pipeline tab and the GLM 5.3
  cutoff view do not move.
- **Correction:** an earlier note said CompanyBench 3's folder held 947 zips
  and its title (961) was out of date. The title is right. The Drive
  connector's paged listing of that folder skipped 14 zips; each was found in
  the folder by a search on its name, and the folder holds 961.
- **GLM 5.3 cutoff** is unchanged: the audit for Batches 1 to 4.1 and the image
  where it names a bench, 3,231 tasks, Company Bench 1,696.
- New checks in `tools/test_drive_deliveries.py`: nested groups, shares,
  audited shares, presence, stray share zips, folder classes, a share two
  levels down in the live read.

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
- **Pipeline, More filters: the dropdowns follow the segment.** State, Gate,
  Finding, Domain and Trainer (and Carried over's State, Gate, Domain and
  Trainer) were filled once from the published vocabulary, which counts the
  whole pipeline, so Company Bench listed General and Engineering domains it
  does not hold. They are now counted over the tasks in the segment and harness
  and refilled on every change: under Computer Bench Connector, Aster or Zeta,
  Domain lists only Not recorded (a domain is a non-connector naming
  convention); under Non-connector, General 1,394, Engineering 812 and the rest.
  A choice already made stays listed, at 0 when the new segment holds none, so
  the filter never changes silently. The Domain dropdown shows its choices
  without counts.
- **Pipeline Domain dropdown names connector tasks by their kind**, not "Not
  recorded". A domain is the prefix on a non-connector task's name (gen-,
  code-, health- ...), which connector tasks do not carry, so every connector
  task read Not recorded. Now: Computer Bench connector tasks are Synthetic,
  Real Connector or Connector (plain base image), by their image; Company Bench
  tasks are Aster or Zeta with Single connector or Multi-connector - the
  Delivery tab's names. Non-connector tasks keep their domains. Company Bench
  tasks whose package was never scanned read "connectors not read" (Zeta
  1,941, Aster 711 pipeline tasks today). Only this dropdown and its filter
  change; the named-domain card and Carried over's Domain still read the name.
- **Pipeline, In the accepted cohort: "distinct accepted tasks" counts the
  folders beside it.** It had been tied to the Overview's Accepted tasks, which
  reads the bucket scan frozen on 28 Sep and adds the two older accepted
  prefixes, so it could not be reconciled with the Accepted card next to it
  (Connector: 235 folders, tile 188). It now folds those same folders by the
  [task] name each package declares, so the card reads folders = tasks + extra
  copies: Connector 235 = 227 + 8, Non-connector 1,687 = 1,625 + 62, Aster 428 =
  426 + 2, Zeta 240 = 227 + 13, All 2,590 = 2,505 + 85. The Duplicates filter's
  15 under Connector is every folder of the 7 tasks that have several (6 x 2 +
  1 x 3), of which 8 are extra copies; Legacy accepted is a separate state and
  is not part of the Accepted card.
- **Pipeline, Delivery & makeup: the Domain chart follows the segment.** It
  counted the name-prefix domain only, which connector tasks do not carry, so
  under Connector, Company Bench, Aster or Zeta it read "No task in this
  selection carries a domain prefix" and showed nothing. It now uses the same
  names as the Domain dropdown: Synthetic, Real Connector and Connector under
  Computer Bench Connector; Aster or Zeta with single or multi-connector (or
  connectors not read) under Company Bench; the five domains under
  Non-connector. Renamed from Named domain to Domain.
- **Pipeline domains are Engineering, Finance, Health, Legal and Other.** gen-
  and bus- tasks were labelled General and Business; both are Other, as on the
  Delivery tab. tools/build_tags.py names them Other from the next pipeline
  build, and the page folds the current data the same way, so the Domain
  dropdown, the named-domain card and Carried over agree: Other 1,659,
  Engineering 812, Health 330, Legal 244, Finance 239 under Non-connector.
  Non-connector tasks whose name carries no prefix stay Not recorded.
- **Fix: the Pipeline's In scope trend lagged one segment behind.** The
  day-by-day model it reads was rebuilt after the Pipeline was drawn, so its
  tasks-a-day and change showed the segment chosen before; on first load it was
  blank. It is now rebuilt first. An empty selection reads 0 tasks decided, not
  1.
- **Harness dropdown on the segment tabs** (Varun's): it listed the raw image
  reading, so Company Bench, Zeta showed "synthetic 5" (the
  obi-benchmark@8219115c tasks that mount the Zeta SQL gym). Inside Company Bench
  a task is now listed under the harness it was put in, so Company Bench shows
  only Aster and Zeta and Computer Bench only synthetic, real and plain base
  image; choosing any entry gives exactly its count. "Non-connector image" is
  renamed "plain base image": the 12 under Connector are connector tasks
  (slack-gym) built on a plain python image. The "Zeta 56" seen under Connector
  came from the deploy before the image-first rule, when a Zeta-image task
  took the bench of the Computer Bench batch it was delivered in; it is 0 now.
- The image rule reaches the audited Batches 1 to 4.1 too: 3 Batch 2 tasks run
  on the Zeta image and move to Company Bench Zeta on the Delivery tab, as the
  Pipeline tab already had them.
- **Delivery tab, Category mix and Category x GLM: Company Bench categories
  are harness and connector count.** A Company Bench package has no category of
  its own - its manifest says "unnamed" or "connector" - so both cards showed
  one bar, CompanyBench. It is now Aster - Single connector, Aster -
  Multi-connector, Zeta - Single connector or Zeta - Multi-connector: one
  connector declared in the task's task.toml, or two and more (gyms only;
  harbor and tags such as read-only are not connectors), read from the
  manifest first and the pipeline's package by name. A new multi-connector Aster
  task lands in its own category as it arrives. Today: Zeta multi 1,463, Aster
  single 224, Zeta single 9, Aster multi none yet. The Category filter and the
  CSV carry the same names.
- A Single / Multi connector switch was tried beside Aster and Zeta and taken
  out again; the count lives in the categories instead. Old links and saved
  choices that carry it are ignored.
- The Drive reader records `harness` on Company Bench rows.

### Delivery tab
- **Batch rail percentages say what they divide by.** Each batch's rate is
  accepted / (accepted + rejected) - the tasks the client has decided - and the
  arithmetic was right (Batch 1 6/60 = 10%, Batch 2 10/59 = 17%, Batch 3 15/60 =
  25%). But "17% accepted" under All batches read as 17% of 3,231 tasks, when it
  is 31 of the 179 decided; 3,052 are still pending. The line now reads "17%
  accepted of 179 decided", and hovering a batch gives accepted, rejected and
  pending.
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
- **Accepted tasks: a current-prefix folder takes its own bench.** The card
  counts distinct task names over all three accepted prefixes, deciding each
  folder's segment by the task's name. Five names are shared by two
  submissions - one on a Zeta image, one on a synthetic one - and two tasks on a
  synthetic image mount the Zeta SQL gym, so 7 Zeta folders counted under
  Computer Bench Connector. A folder of the current prefix now uses the
  Pipeline's own row for it, judged by its own image; the older prefixes have
  no such row and still go by name. Connector 188 -> 182 (one of the seven also
  has an older iteration-1 folder, which still counts it under Connector), Zeta
  179 -> 186. All
  three prefixes stay in the count. The card still reads the 28 Sep scan until
  the refresh is restored.
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
- **yogesh-audit-vm is the dashboard's hub**, replacing task-mining-node-1. Its
  scripts and crontab are in `tools/vm/` (see `tools/vm/README.md`); the copies
  that run are in `/root/shannon-ops-publish/` on the VM. Everything the page
  reads from the bucket is now made there and pushed by the VM itself:
  - `publish.sh` (every 10 min) also runs the bucket scan the pipeline's tags
    read (`pipeline-stats.json`, about two seconds with its cache - node 1 got
    it from a separate dashboard's cron), publishes the bucket export when a
    newer one is ready, and builds the Drive trainer names; it pushes to
    `PUBLISH_BRANCH`.
  - `export-gcs.sh` (every 30 min) makes `gcs-pipeline.json`, the export the
    Overview reads. It takes minutes, so it is off the 10-minute tick.
  - **GitHub no longer fetches anything.** `refresh-gcs.yml` and
    `refresh-truth.yml` pulled from node 1 over SSH on port 2222, which IT
    closed on 28 Sep; they are removed (in `292c6195`). A push to `main` still
    deploys through `deploy.yml`.
  - `tools/export_gcs_pipeline.py` takes a fresh access token when a read gets
    a 401: a run reads ~50,000 objects and outlived its token on the new VM.
  - It publishes **`main`** since 2026-10-06, when staging was released to
    production (`PUBLISH_BRANCH=main` in its crontab). node 1's `publish.sh` and
    `scan-glm.sh` cron lines still have to be removed so only one VM pushes
    `main`.
  - `refresh-drive.sh` (every 15 min) refreshes the Delivery tab's Current view
    from Drive: `build_drive_deliveries.py --audit none` with a snapshot cache,
    then `build_drive_owners.py`, then both Drive test suites; it commits
    `drive-deliveries.json` and `drive-owners.json` only, only when they
    changed. The GLM 5.3 cutoff files are not touched. **Waiting on a Drive
    credential** - a key at `/root/shannon-refresh/drive-reader.json` with
    Viewer on the folder, or the VM's account given the drive.readonly scope;
    until then each run fails safely and records it in `refresh-drive.status`.
    **Taken off the cron on 2026-10-07:** the Delivery tab's Drive files are
    fetched by hand. The script stays on the VM and in `tools/vm/` for a manual
    run.
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
- **The bucket export on `main` is still frozen at 28 Sep 00:46 UTC** (the
  Overview's Accepted tasks and iteration-2 cards, the trainer and bench cards,
  `drive-owners.json`). The GitHub job that fetched it over port 2222 died when
  IT closed that port. yogesh-audit-vm now makes and pushes it - to `staging`
  until it takes over `main`.
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
