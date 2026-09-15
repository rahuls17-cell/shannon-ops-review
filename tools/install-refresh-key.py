"""Install a forced-command public key on the Harbor VM."""
from pathlib import Path

root = Path('/root/shannon-refresh')
public_key = (root / 'shannon-refresh-key.pub').read_text().strip()
assert public_key.startswith('ssh-ed25519 ')
authorized = Path('/root/.ssh/authorized_keys')
previous = authorized.read_text() if authorized.exists() else ''
if public_key.split()[1] not in previous:
    with authorized.open('a') as stream:
        stream.write('\nrestrict,command="/bin/bash /root/shannon-refresh/vm-export.sh" ' + public_key + '\n')
    authorized.chmod(0o600)
for name in ('vm-export.sh', 'export_gcs_pipeline.py'):
    path = root / name
    path.write_bytes(path.read_bytes().replace(b'\r\n', b'\n'))
print('Restricted export key installed')
