"""Read-only access to the pipeline bucket over the GCS JSON API.

The chain's ingest steps import this for the bucket name, the object listing
endpoint, media URLs and a bearer token. The token comes from the caller's own
gcloud login, so nothing here holds a credential.
"""
import subprocess
import urllib.parse
import urllib.request

BUCKET = 'obi-harbor-pipeline'
API = f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o'


def token():
    run = subprocess.run(['gcloud', 'auth', 'print-access-token'],
                         capture_output=True, text=True, timeout=60)
    if run.returncode != 0:
        raise RuntimeError('gcloud has no valid login; run `gcloud auth login` and try again. '
                           + run.stderr.strip()[-200:])
    return run.stdout.strip()


def media_url(name):
    return API + '/' + urllib.parse.quote(name, safe='') + '?alt=media'


def http(url, tok, timeout=120):
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {tok}'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()
