# One addition to the VM's publish.sh

`/root/shannon-ops-publish/publish.sh` rebuilds the pipeline every ten minutes
and pushes it. It runs `build_delivered_index.py` but not
`build_manifest_index.py`, so the live bucket check on the Pipeline tab keeps
whatever date it was last given.

Nothing is broken by that. The thirteen rows the manifests place as already
delivered are recomputed on every tick, because that logic lives inside
`build_delivered_index.py`. Only the sentence *"410 of the 412 packages they
name were still in the bucket when it was listed on ..."* goes stale, and it
prints its own date, so it can look old but cannot mislead.

## The change

In `publish.sh`, immediately **before** the existing
`python3 tools/build_delivered_index.py` line, inside the `cd "$REPO"` section:

```bash
# The delivery manifests against the bucket itself. The listing walks ~3,800
# objects, and already-delivered packages change rarely, so it is refreshed
# once a day rather than on every ten-minute tick. When it is skipped the
# builder carries the previous answer forward and the page keeps printing the
# date it was taken.
LISTING="$BASE/delivery-listing.txt"
if [ ! -f "$LISTING" ] || [ -n "$(find "$LISTING" -mtime +1 2>/dev/null)" ]; then
  log "listing the delivery prefix"
  python3 tools/list_delivery_prefix.py --out "$LISTING" >>"$LOG" 2>&1 \
    || log "listing failed - keeping the previous one"
fi
python3 tools/build_manifest_index.py --listing "$LISTING"
```

Then add `assets/manifest-index.json` to the `git add` line, which currently
reads:

```bash
git add assets/pipeline-truth.json assets/delivered-index.json assets/connector-index.json
```

## Why it is safe to run there

`tools/list_delivery_prefix.py` uses only the standard library and the GCE
metadata server, so it needs no gcloud, no service-account file and no new
package on the VM. It asks for the `devstorage.read_only` scope and issues GET
and nothing else; `tools/test-delivered.cjs` asserts the file cannot express a
write, that it paginates, that it refuses to overwrite a good listing with a
short one, and that it never prints a token.

A failed listing is logged and skipped. It cannot fail the publish, and it
cannot replace a good answer with a wrong one.

## Checking it worked

The next run should log `listing the delivery prefix`, and the Pipeline tab's
delivery-join line should carry the current date rather than 2026-09-22.
