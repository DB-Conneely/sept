/** Opening-only qualification of immutable image snapshots and genuinely sealed host inputs. */
import { SeptError } from "../durable/index.js";
import type { DockerHandsConfiguration } from "./contracts.js";
import type { DockerEngineControl } from "./docker-engine.js";
import { handsRecord } from "./protocol.js";

/** Fixed opening probe authenticates private image provenance, DAC and installed native dependency bytes. */
export const HANDS_IMAGE_ISOLATION_PROBE = `import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function identity(file, uid, gid, mode, directory = false) {
  const stat = fs.lstatSync(file);
  if (fs.realpathSync(file) !== file || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) process.exit(126);
}
identity('/app', 10002, 10001, 0o750, true);
identity('/home/sept-hands', 10002, 10002, 0o700, true);
identity('/home/sept-hands/.pi', 0, 0, 0o755, true);
identity('/home/sept-hands/.pi/agent', 0, 0, 0o755, true);
identity('/usr/local/libexec/sept', 0, 0, 0o555, true);
identity('/home/sept-hands/.pi/agent/bin', 0, 0, 0o555, true);
for (const name of ['hands-command', 'rg', 'fd']) identity('/usr/local/libexec/sept/' + name, 0, 0, 0o555);
for (const name of ['rg', 'fd']) {
  const alias = '/home/sept-hands/.pi/agent/bin/' + name;
  identity(alias, 0, 0, 0o555);
  if (hash(alias) !== hash('/usr/local/libexec/sept/' + name)) process.exit(126);
}
for (const name of ['hands-guard.so', 'hands-guard-check', 'hands-process-control']) identity('/app/' + name, 0, 0, 0o755);
const provenance = '/app/pi-native-search-provenance.json';
identity(provenance, 0, 0, 0o444);
if (fs.statSync(provenance).size > 16384 || hash(provenance) !== 'c42e63b68bc88a38389dea9e1b2aada27c62923a0f734e5ddb234ac15d543f23') process.exit(126);
const pinned = JSON.parse(fs.readFileSync(provenance, 'utf8'));
const installedEntry = import.meta.resolve('@earendil-works/pi-coding-agent', 'file:///app/dist/src/execution/hands-entry.js');
if (installedEntry !== 'file:///app/node_modules/@earendil-works/pi-coding-agent/dist/index.js') process.exit(126);
const root = path.dirname(path.dirname(fileURLToPath(installedEntry)));
if (root !== '/app/node_modules/@earendil-works/pi-coding-agent' || fs.realpathSync(root) !== root || pinned.patch.revision !== 'sept-native-search-v1') process.exit(126);
const manifest = JSON.parse(fs.readFileSync(root + '/package.json', 'utf8'));
if (manifest.name !== pinned.upstream.name || manifest.version !== pinned.upstream.version) process.exit(126);
for (const [file, expected] of Object.entries(pinned.files)) {
  const installed = root + '/' + file;
  if (fs.realpathSync(installed) !== installed || hash(installed) !== expected.effectiveSha256) process.exit(126);
}
process.stdout.write('isolated');`;

/** Parse exact bounded image aliases without resolving or inspecting a host path. */
export function parseImageSelected(
  value: unknown,
  mounts: readonly { destination: string }[] = [],
): { alias: string }[] {
  const aliases = value === undefined ? [] : value;
  if (!Array.isArray(aliases) || aliases.length > 8) {
    throw new SeptError("Hands image selected aliases exceed their bound");
  }
  const images = aliases.map((value: unknown) => {
    const entry = handsRecord(value);
    if (
      Object.keys(entry).length !== 1 ||
      typeof entry.alias !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(entry.alias)
    ) {
      throw new SeptError("Hands image selected alias is malformed");
    }
    return { alias: entry.alias };
  });
  const destinations = [
    ...mounts.map((entry) => entry.destination),
    ...images.map((entry) => `/selected/${entry.alias}`),
  ];
  if (destinations.length > 8 || new Set(destinations).size !== destinations.length) {
    throw new SeptError("Selected mount aliases exceed their bound or collide");
  }
  return images;
}

/** Validate bounded selected trees once; live owners retain image, generation and mount identity. */
export async function validateSelectedInputs(
  configuration: DockerHandsConfiguration,
  engine: DockerEngineControl,
): Promise<void> {
  if (configuration.dataDomain !== "private") {
    if ((configuration.imageSelected?.length ?? 0) > 0) {
      throw new SeptError("Image selected roots require the private data domain");
    }
    return;
  }
  const roots = [
    ...configuration.readOnlyMounts.map((mount) => ({
      path: mount.destination,
      mode: "--sealed",
      response: "sealed\n",
    })),
    ...(configuration.imageSelected ?? []).map((entry) => ({
      path: `/selected/${entry.alias}`,
      mode: "--image-snapshot",
      response: "image-snapshot\n",
    })),
  ];
  for (const root of roots) {
    const result = await engine.exec(configuration.containerId, {
      command: ["/app/hands-guard-check", root.mode, root.path],
      maximum: 128,
    });
    if (result !== root.response) {
      throw new SeptError("Selected input lacks enforced immutable provenance");
    }
  }
}
