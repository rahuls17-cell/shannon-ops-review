#!/usr/bin/env python3
"""List the delivery prefix in the bucket, one object URI per line.

Why this exists
---------------
build_manifest_index.py --listing answers the only question that settles a
delivery: is the exact object each manifest names still in the bucket? That
needs a real listing, and a listing needs credentials.

It is written against the raw JSON API with nothing but the standard library,
because the machine that should run it - the Harbor VM, on its own reliable
cron - may not have the gcloud CLI installed, and a check that only runs where
a particular CLI happens to exist is a check that stops running. Credentials
are taken from whatever the host already has, in this order:

  1. GOOGLE_APPLICATION_CREDENTIALS, if it points at a service account key
  2. the GCE metadata server, which is what the VM itself has
  3. gcloud's own access token, which is what a laptop has

READ ONLY. It issues GET on the storage JSON API and nothing else. It cannot
write to, move or delete anything in the bucket, and it never prints a token.

    python tools/list_delivery_prefix.py --out delivery-listing.txt
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

METADATA = ('http://metadata.google.internal/computeMetadata/v1/'
            'instance/service-accounts/default/token')
SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only'


def token_from_metadata():
    request = urllib.request.Request(METADATA, headers={'Metadata-Flavor': 'Google'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)['access_token']


def token_from_service_account():
    """Only via the google-auth library, which knows how to sign the JWT.

    Not reimplemented here: signing a assertion by hand is exactly the kind of
    crypto that looks fine and is not.
    """
    from google.auth import default          # noqa: PLC0415
    from google.auth.transport.requests import Request  # noqa: PLC0415
    credentials, _ = default(scopes=[SCOPE])
    credentials.refresh(Request())
    return credentials.token


def token_from_gcloud():
    exe = shutil.which('gcloud') or shutil.which('gcloud.cmd')
    if not exe:
        raise FileNotFoundError('gcloud is not on PATH')
    out = subprocess.run([exe, 'auth', 'print-access-token'],
                         capture_output=True, text=True, timeout=120)
    if out.returncode:
        raise RuntimeError((out.stderr or 'gcloud could not produce a token').strip())
    return out.stdout.strip()


def access_token():
    tried = []
    for name, get in (('the GCE metadata server', token_from_metadata),
                      ('a service account key', token_from_service_account),
                      ('gcloud', token_from_gcloud)):
        try:
            value = get()
            if value:
                print(f'authenticated through {name}', file=sys.stderr)
                return value
        except Exception as error:                      # noqa: BLE001
            tried.append(f'  {name}: {type(error).__name__}: {error}')
    raise SystemExit('no credentials this host can use:\n' + '\n'.join(tried))


def list_objects(bucket, prefix, token):
    """Every object under the prefix, following pagination to the end.

    A truncated listing would read as packages having vanished from the
    bucket, so a page that fails is an error rather than the end of the list.
    """
    names, page = [], None
    base = f'https://storage.googleapis.com/storage/v1/b/{urllib.parse.quote(bucket, safe="")}/o'
    while True:
        query = {'prefix': prefix, 'maxResults': '1000', 'fields': 'items(name),nextPageToken'}
        if page:
            query['pageToken'] = page
        request = urllib.request.Request(f'{base}?{urllib.parse.urlencode(query)}',
                                         headers={'Authorization': f'Bearer {token}'})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = json.load(response)
        except urllib.error.HTTPError as error:
            raise SystemExit(f'listing failed with HTTP {error.code}: '
                             f'{error.read().decode("utf-8", "replace")[:300]}') from error
        names.extend(item['name'] for item in body.get('items', []))
        page = body.get('nextPageToken')
        if not page:
            return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bucket', default='obi-harbor-pipeline')
    ap.add_argument('--prefix', default='tasks/finalisation_client_qc_accepted_iteration_2/')
    ap.add_argument('--out', default='delivery-listing.txt')
    ap.add_argument('--min-objects', type=int, default=1000,
                    help='refuse to write a listing smaller than this. A short '
                         'listing does not mean the packages are gone, it means '
                         'the listing is wrong, and overwriting a good one with '
                         'it would report a delivery as missing.')
    args = ap.parse_args()

    names = list_objects(args.bucket, args.prefix, access_token())
    if len(names) < args.min_objects:
        raise SystemExit(f'only {len(names)} objects under {args.prefix} - expected at least '
                         f'{args.min_objects}. Keeping the previous listing.')

    out = pathlib.Path(args.out)
    # Written whole, then moved into place, so a listing interrupted halfway
    # never becomes the file the manifest check reads.
    temporary = out.with_suffix(out.suffix + '.tmp')
    temporary.write_text(''.join(f'gs://{args.bucket}/{name}\n' for name in names),
                         encoding='utf-8')
    temporary.replace(out)

    folders = {name[len(args.prefix):].split('/', 1)[0] for name in names
               if name.startswith(args.prefix) and '/' in name[len(args.prefix):]}
    print(f'{len(names):,} objects in {len(folders):,} task folders -> {out}')


if __name__ == '__main__':
    main()
