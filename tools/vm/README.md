# The dashboard's VM: yogesh-audit-vm

Since 2026-10-05 every asset the page reads from the bucket is built on
**yogesh-audit-vm** (`us-central1-f`, project `delivery-g-obi`) and pushed to
this repo by the VM itself. It replaces `task-mining-node-1`, which did the
same job; node 1 keeps running untouched until the switch-over below.

The files here are the version-controlled copies. The copies that run are in
`/root/shannon-ops-publish/` on the VM, as root.

| File | Runs | Does |
|---|---|---|
| `publish.sh` | every 10 min | scans the bucket, rebuilds the pipeline (`refresh_truth.sh` in the chain directory), rejoins every index, copies in the latest bucket export and GLM band, builds the Drive trainer names, commits the assets and pushes to `PUBLISH_BRANCH` |
| `export-gcs.sh` | every 30 min | writes the bucket export (`gcs-pipeline.json`: accepted folders in all three prefixes, evaluations, trainer records) beside `publish.sh`; takes minutes, so it is not on the 10-minute tick |
| `refresh-drive.sh` | by hand (off the cron since 2026-10-07) | the Delivery tab's Current view from the Drive Deliveries folder: `drive-deliveries.json` (`--audit none`, so Batches 1 to 4.1 come from Drive too) and `drive-owners.json`; commits those two files only, only when they changed and both Drive test suites pass. Folders it skips are logged. Last result in `refresh-drive.status` |
| `scan-glm.sh` | daily 03:17 UTC | the four-trial GLM band (`glm-index.json`); about a quarter of an hour |
| `crontab.txt` | | root's crontab on the VM |

## What it needs on the VM

- `/root/shannon-ops-publish/` - these scripts, `repo/` (a clone of this
  repository), the caches (`bench-index.json`, `task-names-cache.json`,
  `delivery-listing.txt`, `glm-index.json`).
- `/root/harbor_gce/delivery-candidates-20260908-codex/pipeline-dashboard/` -
  the pipeline chain (`refresh_truth.sh`, `ingest_verdicts.py` ...) and
  `scan_bucket.py`, which is not in this repository.
- `/root/shannon-refresh/finalisation-cache.json` - the exporter's archive cache.
- Bucket access: the VM's service account
  (`713053229214-compute@developer.gserviceaccount.com`). Nothing writes to the
  bucket.
- Drive read (for `refresh-drive.sh`), not set up yet - a person has to do one
  of these; nothing here creates keys:
  - a service account key at `/root/shannon-refresh/drive-reader.json` (mode
    600), its account given **Viewer** on the Deliveries folder
    (`1_ZA8ckJfXtaGV4OpqZ0a4f5XZbx4brXO`); the folder's turing.com link sharing
    does not reach a service account. Needs `python3-google-auth` (installed);
  - or the VM's own service account given the
    `https://www.googleapis.com/auth/drive.readonly` scope (the VM has to be
    stopped to change scopes) and Viewer on the folder.
  Until then every run fails safely and says so in `refresh-drive.status`.
- GitHub push: `/root/.ssh/shannon_ops_push` (a deploy key on this repo) and a
  `Host github-shannon-ops` entry in `/root/.ssh/config`; the clone's remote is
  `git@github-shannon-ops:rahuls17-cell/shannon-ops-review.git`.

## Getting in

Port 2222 is closed to the internet (IT, 2026-09-28). SSH goes through IAP on
port 22, which needs `roles/iap.tunnelResourceAccessor`:

```bash
gcloud compute start-iap-tunnel yogesh-audit-vm 22 --local-host-port=localhost:2223 --zone us-central1-f --project delivery-g-obi
ssh -p 2223 podlead@localhost
```

On Windows use OpenSSH (Git Bash), not `gcloud compute ssh`, which goes through
PuTTY.

## What GitHub no longer does

`refresh-gcs.yml` and `refresh-truth.yml` fetched the bucket export and the
pipeline from node 1 over SSH on port 2222. That route closed on 2026-09-28,
which froze `gcs-pipeline.json` from then on. Both are retired: `publish.sh`
makes and pushes everything they did. A push to `main` still deploys the site
through `deploy.yml`.

## Switching over from node 1

1. While testing, the VM publishes to `staging` (`PUBLISH_BRANCH=staging` in
   the crontab) and node 1 keeps publishing `main`. Deploy staging with
   `data_ref=staging` to see what the VM produces.
2. To take over `main`: in the same step, remove node 1's `publish.sh` and
   `scan-glm.sh` cron lines and set `PUBLISH_BRANCH=main` here. Two VMs must
   never both push `main`.
3. Remove from node 1 only what moved here, once nothing else on node 1 uses it.

`tools/sync_index.py` and `tools/truth_server.py` still name node 1's address;
they are local helpers, not part of the refresh.
