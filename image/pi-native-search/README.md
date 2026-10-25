# Image-only native search seam

SEPT overlays exactly `dist/core/tools/{find,grep}.{d.ts,js}` in the locked
`@earendil-works/pi-coding-agent` 1.1.0 image installation. Only the optional
`spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"] })` callback and its
minimal readable-stream/kill/error/close declaration are added. Native schemas,
arguments, parsing, formatting, limits and abort conventions stay upstream-owned.
Without the optional callback, Pi retains its original spawn behavior; SEPT binds
it to current command authority and refuses a missing active binding.

This is an explicit image dependency patch, revision `sept-native-search-v1`, not
a registry package identity or consumer install hook. Pi source/tool bodies and
package name/version remain upstream 1.1.0. The separate [security distribution](../../vendor/README.md)
changes only the undici dependency pin to 8.12.2 for host, image and npm consumers.
`provenance.json` remains the record of the original upstream registry integrity, original
and effective four-file hashes, patch revision/hash and overlay SHA256/SHA512.
Changed files omit obsolete source map references; Docker removes their four maps.
The build verifies the exact regular-file archive allowlist before extraction,
original bytes, effective bytes before compilation, after prune and after final COPY.

The upstream registry archive contains no LICENSE file. The complete upstream
notice below is from the v1.1.0 repository tag, commit
`abe508e1b89912adde45528136c3221eb69acdd7`; its exact URL/hash are in provenance.
The image retains this same README at private `/app/pi-native-search-README.md`
and provenance at `/app/pi-native-search-provenance.json`. No upstream LICENSE
file is fabricated or removed.

## Reproduce the asset

Run from the SEPT checkout using Node 22, GNU patch, GNU tar 1.35 and gzip 1.14
(the producing tools). No install or root dependency edit is involved. Keep the
isolated work directory for inspection; the final `cmp` proves compressed-byte identity.

```bash
set -euo pipefail
asset_dir="$PWD/image/pi-native-search"
work_dir="$(mktemp -d)"
export asset_dir work_dir
curl -fL "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.1.0.tgz" -o "$work_dir/upstream.tgz"
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(`${process.env.asset_dir}/provenance.json`, "utf8"));
const hash = (path, algorithm, encoding = "hex") => createHash(algorithm).update(readFileSync(path)).digest(encoding);
assert.equal(`sha512-${hash(`${process.env.work_dir}/upstream.tgz`, "sha512", "base64")}`, p.upstream.integrity);
assert.equal(hash(`${process.env.asset_dir}/native-search.patch`, "sha256"), p.patch.sha256);
JS
mkdir "$work_dir/package"
tar -xzf "$work_dir/upstream.tgz" -C "$work_dir/package" --strip-components=1 \
  package/dist/core/tools/find.d.ts package/dist/core/tools/find.js \
  package/dist/core/tools/grep.d.ts package/dist/core/tools/grep.js
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(`${process.env.asset_dir}/provenance.json`, "utf8"));
for (const [path, hashes] of Object.entries(p.files)) {
  assert.equal(createHash("sha256").update(readFileSync(`${process.env.work_dir}/package/${path}`)).digest("hex"), hashes.originalSha256);
}
JS
patch -d "$work_dir/package" -p1 < "$asset_dir/native-search.patch"
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(`${process.env.asset_dir}/provenance.json`, "utf8"));
for (const [path, hashes] of Object.entries(p.files)) {
  assert.equal(createHash("sha256").update(readFileSync(`${process.env.work_dir}/package/${path}`)).digest("hex"), hashes.effectiveSha256);
}
JS
(
  cd "$work_dir/package"
  LC_ALL=C tar --format=ustar --mode=0644 --owner=0 --group=0 --numeric-owner --mtime=@0 -cf - \
    dist/core/tools/find.d.ts dist/core/tools/find.js \
    dist/core/tools/grep.d.ts dist/core/tools/grep.js | gzip -n -9 > "$work_dir/overlay.tgz"
)
cmp "$asset_dir/overlay.tgz" "$work_dir/overlay.tgz"
```

## Upstream MIT license

<!-- BEGIN UPSTREAM MIT LICENSE -->

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

<!-- END UPSTREAM MIT LICENSE -->
