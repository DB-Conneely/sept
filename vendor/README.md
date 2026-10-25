# Pi 1.1.0 security distribution

`pi-coding-agent-1.1.0-undici-8.12.2.tgz` retains the upstream package name/version and all 1,253 source, declaration, map and tool files byte for byte. The sole change is `package/package.json` → `dependencies.undici`: `8.10.2` → `8.12.2`. This fixes GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472 and GHSA-xjj6-f33q-929c without a provider/runtime fork or install hook. The original MIT notice remains in SEPT's root NOTICE.

The exact local file dependency ships inside SEPT's npm package, so downstream npm installs resolve the fixed pin without requiring a consumer override. A root-only npm override or published shrinkwrap did not secure cold npm 10/11 tarball consumers. Pi, chord and codemode remain version 1.1.0 and use normal shared module resolution. Docker separately applies the existing four-file native search overlay; its original upstream provenance is unchanged.

`pi-coding-agent-provenance.json` records the original registry URL/integrity, effective archive SHA256/integrity, original manifest hash, exact field correction, and canonical aggregate of every unchanged body. Meta-tests verify those bytes and the package lock; release consumers check the dependency resolved from Pi's actual installed package directory and run npm ls/audit.

To reproduce on Python 3.12, obtain the original archive with `npm pack @earendil-works/pi-coding-agent@1.1.0 --ignore-scripts`. Run this in the directory containing that archive and a copy of the provenance file; the final assertion proves compressed-byte identity. No credentials or model request are needed.

```python
import base64, gzip, hashlib, io, json, tarfile

p = json.load(open("pi-coding-agent-provenance.json"))
source = "earendil-works-pi-coding-agent-1.1.0.tgz"
target = "pi-coding-agent-1.1.0-undici-8.12.2.tgz"
assert "sha512-" + base64.b64encode(hashlib.sha512(open(source, "rb").read()).digest()).decode() == p["upstream"]["integrity"]
with tarfile.open(source) as original, open(target, "wb") as output:
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
        with tarfile.open(mode="w|", fileobj=compressed, format=tarfile.PAX_FORMAT) as archive:
            for member in original:
                body = original.extractfile(member).read() if member.isfile() else None
                if member.name == "package/package.json":
                    assert body.count(b'"undici": "8.10.2"') == 1
                    body = body.replace(b'"undici": "8.10.2"', b'"undici": "8.12.2"')
                    member.size = len(body)
                archive.addfile(member, io.BytesIO(body) if body is not None else None)
assert hashlib.sha256(open(target, "rb").read()).hexdigest() == p["distribution"]["sha256"]
```
