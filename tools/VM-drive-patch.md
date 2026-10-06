> **Superseded on yogesh-audit-vm.** The Drive refresh now runs as its own job,
> `tools/vm/refresh-drive.sh` (every 15 minutes; see `tools/vm/README.md`),
> rather than as lines in `publish.sh`. The credential steps below still apply.

# Reading the Drive batch manifests on the VM

The Delivery tab lists Batch 5.1 onwards, and the CompanyBench batches, from the
`manifest.json` in each batch folder of the shared **Deliveries** folder on Drive.
`tools/build_drive_deliveries.py` reads that folder and writes
`assets/drive-deliveries.json`. For a new batch to appear by itself, the VM's
ten-minute `publish.sh` has to run it, and the VM needs a credential that can
read the folder.

Until both steps below are done, the asset stays whatever was last committed.
The page prints the date it was read, so an old copy shows its age rather than
passing for a current one.

## 1. A read-only Drive identity

1. In the Harbor GCP project, create a service account, for example
   `shannon-drive-reader`. It needs **no IAM roles**: Drive access comes only
   from sharing, not from the project.
2. Create a JSON key for it and put it on the VM:

   ```bash
   install -m 600 key.json /root/shannon-refresh/drive-reader.json
   ```

3. In Drive, share **Deliveries** with the service account's email as
   **Viewer**. The folder's link sharing does not cover a service account,
   because it is not a turing.com user.
4. Check that the library the script signs with is present:

   ```bash
   python3 -c "import google.oauth2.service_account, google.auth.transport.requests"
   # if it is not:  pip3 install google-auth requests
   ```

The script only issues GET requests, and the scope it asks for is
`drive.readonly`, so the key cannot change anything in Drive even if it leaks.
Keep it out of the repository all the same.

## 2. The addition to `publish.sh`

In `/root/shannon-ops-publish/publish.sh`, inside the `cd "$REPO"` section and
before the `git add` line:

```bash
# Delivered batches from their Drive manifests. A failed read exits before it
# writes, so the previous asset stays in place and the page keeps its date.
# The snapshot directory doubles as a cache: a manifest whose Drive
# modifiedTime has not moved is not downloaded again.
DRIVE_CREDENTIALS=/root/shannon-refresh/drive-reader.json \
  python3 tools/build_drive_deliveries.py --save-dir "$BASE/drive-snapshot" >>"$LOG" 2>&1 \
  || log "Drive read failed - keeping the previous drive-deliveries.json"
```

Right after it, name the trainers for the new rows from the bucket scan. This
needs no credentials: it reads `assets/gcs-pipeline.json` and
`assets/pipeline-truth.json`, which are already in the checkout. The refresh
workflows rebuild it on their own schedule too; running it here means a new
batch has trainers from its first publish.

```bash
python3 tools/build_drive_owners.py >>"$LOG" 2>&1 \
  || log "Drive owner index failed - keeping the previous drive-owners.json"
```

Then add `assets/drive-deliveries.json` and `assets/drive-owners.json` to that
`git add` line.

## 3. Checking it

Run it once by hand:

```bash
cd "$REPO"
DRIVE_CREDENTIALS=/root/shannon-refresh/drive-reader.json \
  python3 tools/build_drive_deliveries.py --save-dir /root/shannon-refresh/drive-snapshot
```

It prints one line per batch it read, every folder it skipped and why, and the
row count. On 2026-09-30 the folder gave 9 batches and 2,826 tasks: Batch 5.1 to
10.1 and CompanyBench 1 to 3. One folder was skipped:
`09-28 Batch3 CompanyBench - 9 Synthetic Tasks` has no `manifest.json`, and its 9
tasks are already inside the CompanyBench 3 manifest.

`python3 tools/test_drive_deliveries.py` checks the folder rules and the
published asset. CI runs it on every push.

## What decides whether a folder is read

- **Read:** a folder (not a shortcut) whose name says which batch it is, such as
  `09-29 Batch 9.1`, or `09-27 Batch1 CompanyBench 267`, which is read as
  `CompanyBench 1`, and that has a `manifest.json` at its top level. It can sit
  at the top of Deliveries or one level down in a group folder: since
  2026-09-30 the batches live in `ComputerBench/` and `CompanyBench/`.
- **Ignored:** names containing deprecated, partial, dupes, shipment, meta,
  KnowledgeWork, EKW or SVC, together with everything inside such a group; files;
  shortcuts; and any batch the delivery audit already covers (Batches 1 to 4.1,
  which keep their audited rows).
- **Dedup copies win:** when a folder with "dedup" in its name claims the same
  batch as another, the dedup copy is the batch and the other is not read. Its
  `manifest.json` may still be the pre-dedup one, so only the manifest rows whose
  zip is actually in the dedup copy are published, and the rest are listed on the
  batch. `09-25-Batch5.1 (dedup copy 2026-09-30)` holds 382 of its manifest's 397
  packages; the 15 taken out were also delivered in CompanyBench 2 and 3.
- **Read once:** two folders claiming one batch with byte-identical manifests,
  when neither is a dedup copy.
- **Skipped, with a warning on the page:** a batch folder with no manifest yet,
  two folders claiming the same batch with different manifests, or a manifest
  whose tasks lack a `package_path`, `sha256` or `size_bytes`. The other batches
  still publish.

Each batch folder's zips are listed with the Drive folder they sit in, and that
folder decides the bench: anything in a `CompanyBench` folder is Company Bench,
also inside a Computer Bench batch. 5.1, 6.1 and 7.1 file their Company Bench
connectors there while their manifests call the same packages `Connector/`.
Everything in a CompanyBench batch is Company Bench, except tasks its manifest
marks as computer bench.

Each row is named by the name the package's `task.toml` declares (the
manifest's `task_name`); the package file name, sometimes an id such as
`ASTR_101554`, is kept beside it and is searchable.
