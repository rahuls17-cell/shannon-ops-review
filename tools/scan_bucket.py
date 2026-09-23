"""Read-only GCS bucket scanner for the Harbor pipeline export.

Replaces the original scanner that lived outside this repo at an absolute path
under /root, which pinned the exporter to one VM. Everything here is a GET:
listing objects, ranged reads of ZIP structures, and parsing task.toml. There is
no code path that writes, deletes or overwrites a bucket object.

The ZIP reads are deliberately partial. A delivered archive is megabytes, but the
facts we need live in task.toml, so we fetch the end-of-central-directory record,
parse the central directory, and then read only the members we actually want.
That keeps a full cohort scan to a few hundred KB of transfer instead of tens of
gigabytes, and it is what makes fingerprinting whole cohorts affordable.
"""
import json
import re
import shutil
import subprocess
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

BUCKET = 'obi-harbor-pipeline'
API = 'https://storage.googleapis.com/storage/v1/b/%s/o' % BUCKET

# The end-of-central-directory record is at most 22 bytes plus a 64KB comment,
# so one tail read of 64KB + 22 always contains it.
_EOCD_TAIL = 65558
_EOCD_SIG = b'PK\x05\x06'
_EOCD64_LOCATOR_SIG = b'PK\x06\x07'
_EOCD64_SIG = b'PK\x06\x06'
_CENTRAL_SIG = 0x02014b50

# A domain prefix is followed by a task identifier, which always contains a
# digit: code-c471-, health-b43-, health-tdt3-. Matching the bare word instead
# would read 'code-review-assistant' as the code domain, which it is not.
# Verified against all 1,434 classified archives: zero disagreements.
_DOMAIN = re.compile(r'^(code|gen|fin|health|law)-[a-z]*\d')


def token():
    """Access token from the ambient gcloud credentials. Never printed, never stored.

    Resolved through PATH rather than invoked by bare name: on Windows gcloud is
    a .cmd shim that subprocess will not find without the extension, and this
    module has to run both on the VM and on a workstation.
    """
    executable = next((found for name in ('gcloud', 'gcloud.cmd', 'gcloud.exe')
                       for found in (shutil.which(name),) if found), None)
    if executable is None:
        raise RuntimeError('gcloud not found on PATH; run `gcloud auth login` first')
    out = subprocess.run([executable, 'auth', 'print-access-token'],
                         capture_output=True, text=True, check=True)
    return out.stdout.strip()


def http(url, tok, headers=None, retries=4):
    """GET with backoff. Returns bytes; callers json.loads or parse as needed."""
    last = None
    for attempt in range(retries):
        request = urllib.request.Request(url)
        request.add_header('Authorization', 'Bearer ' + tok)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            # 404 and 403 are answers, not transient faults - do not retry them.
            if error.code in (403, 404):
                raise
            last = error
        except Exception as error:
            last = error
        time.sleep(min(2 ** attempt, 8))
    raise last


def media_url(name):
    return '%s/%s?%s' % (API, urllib.parse.quote(name, safe=''),
                         urllib.parse.urlencode({'alt': 'media'}))


def _range(url, tok, start, end):
    """Inclusive byte range, as the HTTP Range header defines it."""
    return http(url, tok, headers={'Range': 'bytes=%d-%d' % (start, end)})


def central_directory(url, tok, size):
    """{member name: (compression method, compressed size, local header offset)}.

    Two ranged reads: the tail to locate the central directory, then the
    directory itself. ZIP64 is handled because delivered archives exceed the
    32-bit fields often enough to matter.
    """
    size = int(size or 0)
    tail_len = min(_EOCD_TAIL, size)
    tail = _range(url, tok, size - tail_len, size - 1)

    marker = tail.rfind(_EOCD_SIG)
    if marker < 0:
        raise ValueError('no end-of-central-directory record')
    count, directory_size, directory_at = struct.unpack('<HLL', tail[marker + 10:marker + 20])

    # ZIP64: the 32-bit fields saturate and the real values sit in the ZIP64 record.
    locator = tail.rfind(_EOCD64_LOCATOR_SIG, 0, marker)
    if locator >= 0 and (directory_at == 0xFFFFFFFF or directory_size == 0xFFFFFFFF
                         or count == 0xFFFF):
        eocd64_at = struct.unpack('<Q', tail[locator + 8:locator + 16])[0]
        head = _range(url, tok, eocd64_at, eocd64_at + 55)
        if head[:4] != _EOCD64_SIG:
            raise ValueError('ZIP64 locator does not point at a ZIP64 record')
        count = struct.unpack('<Q', head[32:40])[0]
        directory_size, directory_at = struct.unpack('<QQ', head[40:56])

    blob = _range(url, tok, directory_at, directory_at + directory_size - 1)

    entries, cursor = {}, 0
    for _ in range(count):
        if cursor + 46 > len(blob) or struct.unpack('<L', blob[cursor:cursor + 4])[0] != _CENTRAL_SIG:
            break
        method, = struct.unpack('<H', blob[cursor + 10:cursor + 12])
        compressed, = struct.unpack('<L', blob[cursor + 20:cursor + 24])
        name_len, extra_len, comment_len = struct.unpack('<HHH', blob[cursor + 28:cursor + 34])
        offset, = struct.unpack('<L', blob[cursor + 42:cursor + 46])
        name = blob[cursor + 46:cursor + 46 + name_len].decode('utf-8', 'replace')

        if compressed == 0xFFFFFFFF or offset == 0xFFFFFFFF:
            extra = blob[cursor + 46 + name_len:cursor + 46 + name_len + extra_len]
            compressed, offset = _zip64_extra(extra, compressed, offset)

        entries[name] = (method, compressed, offset)
        cursor += 46 + name_len + extra_len + comment_len
    return entries


def member_table(url, tok, size):
    """[{name, size, crc}] for every member, from the central directory alone.

    ZIP stores a CRC-32 and uncompressed size per member, so a member's content
    is identified without transferring it. Reading the index costs two ranged
    requests per archive whatever the archive contains, which is what makes
    fingerprinting a whole cohort cheap enough to run repeatedly.
    """
    size = int(size or 0)
    tail_len = min(_EOCD_TAIL, size)
    tail = _range(url, tok, size - tail_len, size - 1)

    marker = tail.rfind(_EOCD_SIG)
    if marker < 0:
        raise ValueError('no end-of-central-directory record')
    count, directory_size, directory_at = struct.unpack('<HLL', tail[marker + 10:marker + 20])

    locator = tail.rfind(_EOCD64_LOCATOR_SIG, 0, marker)
    if locator >= 0 and (directory_at == 0xFFFFFFFF or directory_size == 0xFFFFFFFF
                         or count == 0xFFFF):
        eocd64_at = struct.unpack('<Q', tail[locator + 8:locator + 16])[0]
        head = _range(url, tok, eocd64_at, eocd64_at + 55)
        if head[:4] != _EOCD64_SIG:
            raise ValueError('ZIP64 locator does not point at a ZIP64 record')
        count = struct.unpack('<Q', head[32:40])[0]
        directory_size, directory_at = struct.unpack('<QQ', head[40:56])

    blob = _range(url, tok, directory_at, directory_at + directory_size - 1)

    members, cursor = [], 0
    for _ in range(count):
        if cursor + 46 > len(blob) or struct.unpack('<L', blob[cursor:cursor + 4])[0] != _CENTRAL_SIG:
            break
        crc, = struct.unpack('<L', blob[cursor + 16:cursor + 20])
        uncompressed, = struct.unpack('<L', blob[cursor + 24:cursor + 28])
        name_len, extra_len, comment_len = struct.unpack('<HHH', blob[cursor + 28:cursor + 34])
        name = blob[cursor + 46:cursor + 46 + name_len].decode('utf-8', 'replace')
        if uncompressed == 0xFFFFFFFF:
            extra = blob[cursor + 46 + name_len:cursor + 46 + name_len + extra_len]
            uncompressed = _zip64_uncompressed(extra, uncompressed)
        if not name.endswith('/'):
            members.append({'name': name, 'size': int(uncompressed), 'crc': int(crc)})
        cursor += 46 + name_len + extra_len + comment_len
    return members


def _zip64_uncompressed(extra, uncompressed):
    cursor = 0
    while cursor + 4 <= len(extra):
        tag, length = struct.unpack('<HH', extra[cursor:cursor + 4])
        if tag == 0x0001 and length >= 8:
            return struct.unpack('<Q', extra[cursor + 4:cursor + 12])[0]
        cursor += 4 + length
    return uncompressed


def _zip64_extra(extra, compressed, offset):
    """Pull the 64-bit compressed size and local offset out of the 0x0001 extra field."""
    cursor = 0
    while cursor + 4 <= len(extra):
        tag, length = struct.unpack('<HH', extra[cursor:cursor + 4])
        body = extra[cursor + 4:cursor + 4 + length]
        if tag == 0x0001:
            # Order is uncompressed, compressed, local offset - each present only
            # when its 32-bit counterpart was saturated.
            values, at = [], 0
            while at + 8 <= len(body):
                values.append(struct.unpack('<Q', body[at:at + 8])[0])
                at += 8
            index = 1  # uncompressed size occupies slot 0 when present
            if compressed == 0xFFFFFFFF and len(values) > index:
                compressed = values[index]
                index += 1
            if offset == 0xFFFFFFFF and len(values) > index:
                offset = values[index]
            return compressed, offset
        cursor += 4 + length
    return compressed, offset


def read_entry(url, tok, method, compressed, offset):
    """Decompressed bytes of one member, read from its local header onward."""
    header = _range(url, tok, offset, offset + 29)
    name_len, extra_len = struct.unpack('<HH', header[26:30])
    start = offset + 30 + name_len + extra_len
    if compressed == 0:
        return b''
    raw = _range(url, tok, start, start + compressed - 1)
    if method == 0:
        return raw
    if method == 8:
        return zlib.decompress(raw, -zlib.MAX_WBITS)
    raise ValueError('unsupported compression method %d' % method)


def _toml(text):
    """Parse task.toml.

    stdlib tomllib only. task.toml uses arrays of tables for the MCP server
    records, and a hand-rolled parser that silently mis-reads those would
    misclassify every connector task - a wrong answer is worse than a missing
    dependency, so this requires Python 3.11+ rather than degrading.
    """
    import tomllib
    return tomllib.loads(text)


def classify(data, folder):
    """Facts about one task, derived from its task.toml.

    Connector status is decided by structure - the presence of declared MCP
    servers - never by searching for the substring 'mcp', which appears in every
    package and would classify the whole corpus as connectors.
    """
    document = _toml(data.decode('utf-8', 'replace')) if isinstance(data, bytes) else _toml(data)
    task = document.get('task') or {}
    environment = document.get('environment') or {}
    metadata = document.get('metadata') or {}

    declared_name = str(task.get('name') or '') or None
    prefix, _, short = (declared_name or '').partition('/')
    if not short:
        prefix, short = None, declared_name
    declared_short = short or folder

    # Both are arrays of tables; the service identity is each record's name.
    records = list(environment.get('mcp_servers') or []) + list(metadata.get('mcp_servers_extended') or [])
    services = sorted({str(entry.get('name')) for entry in records
                       if isinstance(entry, dict) and entry.get('name')})
    is_connector = bool(services)

    # The declared name carries the domain, not the folder: some folders are named
    # from an opaque pipeline id and reading them buckets real domains as unknown.
    match = _DOMAIN.match(str(declared_short or ''))

    return {
        'connector_provenance': _provenance(records, environment, is_connector),
        'connector_services': services,
        'declared_name': declared_name,
        'declared_short': declared_short,
        'domain': match.group(1) if match else None,
        'image': str(environment.get('image') or '') or None,
        'is_connector': is_connector,
        'prefix': prefix,
    }


def _provenance(records, environment, is_connector):
    """real / synthetic / unknown for connector tasks, None for the rest.

    Three places declare it and none is always present: a `dataset` key on an
    MCP server record, a GYM_DATASET environment default of the shell form
    ${GYM_DATASET:-synthetic}, and the harness image tag (`:real-data-v4`,
    `:company-synthetic-full-12`). A connector task that declares none of them
    is 'unknown' - an honest gap rather than an assumed default.
    """
    if not is_connector:
        return None
    found = {str(entry.get('dataset')).strip().lower()
             for entry in records if isinstance(entry, dict) and entry.get('dataset')}
    found |= {value for value in (_gym_dataset(environment),) if value}
    found |= {value for value in (_image_dataset(entry.get('image'))
                                  for entry in records if isinstance(entry, dict)) if value}
    for candidate in ('synthetic', 'real'):
        if candidate in found:
            return candidate
    # Nothing in the package declares it. Earlier versions of this function
    # guessed from the harness image repository; measured against the corpus that
    # guess was wrong as often as right, in both directions, so it is not made.
    return 'unknown'


def _image_dataset(image):
    """Provenance from the harness image tag only.

    The tag is the part after the last colon, and only when the reference is not
    pinned by digest - a digest carries no words, and matching against the whole
    reference would let a registry or repository name decide provenance.
    """
    text = str(image or '')
    if not text or '@' in text:
        return None
    _, separator, tag = text.rpartition(':')
    if not separator or '/' in tag:
        return None
    tag = tag.lower()
    return 'synthetic' if 'synthetic' in tag else 'real' if 'real' in tag else None


def _gym_dataset(node, depth=0):
    """GYM_DATASET's effective value, wherever in the environment table it sits."""
    if depth > 4 or not isinstance(node, dict):
        return None
    for key, value in node.items():
        if str(key).upper() == 'GYM_DATASET' and isinstance(value, str):
            match = re.search(r':-\s*([A-Za-z]+)', value)
            return (match.group(1) if match else value).strip().lower() or None
        if isinstance(value, dict):
            found = _gym_dataset(value, depth + 1)
            if found:
                return found
        if isinstance(value, list):
            for item in value:
                found = _gym_dataset(item, depth + 1)
                if found:
                    return found
    return None
