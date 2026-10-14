/** Inspect consumer-installed kernel filters; commands never receive the privileged control identity. */
import { SeptError } from "../durable/index.js";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { DockerHandsConfiguration } from "./contracts.js";
import { DockerEngineControl } from "./docker-engine.js";
import { networkFirewall } from "./network-profile.js";
import { handsRecord } from "./protocol.js";

// Engine aliases can reach the brain without appearing on its OS interfaces. Only a fixed bounded
// trusted inspection runs outside the command guard; its addresses still require operator inventory.
const HOST_ALIAS_INSPECTION = `
const dns = require("node:dns").promises;
const hosts = require("node:fs").readFileSync("/etc/hosts", "utf8");
if (hosts.length > 16384) process.exit(126);
const servers = JSON.parse(process.argv[1]);
const timer = setTimeout(() => process.exit(126), 5000);
Promise.all(["host.docker.internal", "gateway.docker.internal"].map(async name => {
  const local = hosts.split("\\n").map(line => line.split("#")[0].trim().split(/\\s+/)).filter(parts => parts.slice(1).includes(name)).map(parts => parts[0]);
  const records = await Promise.all(servers.map(async server => {
    const resolver = new dns.Resolver({ timeout: 1000, tries: 1 }); resolver.setServers([server]);
    return (await Promise.all([resolver.resolve4(name), resolver.resolve6(name)].map(query => query.catch(error => {
      if (["ENOTFOUND", "ENODATA", "ETIMEOUT", "ECONNREFUSED", "EREFUSED", "EBADRESP"].includes(error.code)) return []; throw error;
    })))).flat();
  }));
  return [...new Set([...local, ...records.flat()])];
})).then(entries => {
  const addresses = [...new Set(entries.flat())];
  if (addresses.length > 16) process.exit(126);
  process.stdout.write(JSON.stringify({ addresses, complete: entries.every(entry => entry.length > 0) })); clearTimeout(timer);
}).catch(() => process.exit(126));`;

async function validateHostAliases(
  configuration: DockerHandsConfiguration,
  engine: DockerEngineControl,
): Promise<string[]> {
  const raw = await engine.exec(configuration.containerId, {
    user: "0:0",
    command: [
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "node",
      "--eval",
      HOST_ALIAS_INSPECTION,
      JSON.stringify(configuration.network?.dnsServers),
    ],
    maximum: 4096,
  });
  return hostAliasAddresses(raw, configuration, {
    required: engine.operatingSystem === "Docker Desktop",
  });
}

function parsedAliasResult(raw: string): { addresses: unknown[]; complete: boolean } {
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch (error: unknown) {
    throw new SeptError("Docker host alias inspection is malformed", { cause: error });
  }
  const output = handsRecord(values);
  if (
    !Array.isArray(output.addresses) ||
    output.addresses.length > 16 ||
    typeof output.complete !== "boolean"
  ) {
    throw new SeptError("Docker host alias inspection is malformed");
  }
  return { addresses: output.addresses, complete: output.complete };
}

function canonicalAlias(value: unknown): string {
  if (typeof value !== "string" || value.length > 45 || isIP(value) === 0) {
    throw new SeptError("Docker host alias inspection is malformed");
  }
  return isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value;
}

function hostAliasAddresses(
  raw: string,
  configuration: DockerHandsConfiguration,
  options: { required: boolean },
): string[] {
  const output = parsedAliasResult(raw);
  if (options.required && !output.complete) {
    throw new SeptError(
      "Docker engine host aliases require an inspectable resolver and complete protection inventory",
    );
  }
  const aliases = output.addresses.map((value) => canonicalAlias(value));
  if (aliases.some((alias) => configuration.network?.protectedAddresses.includes(alias) !== true)) {
    throw new SeptError("Docker host alias is absent from network exclusions");
  }
  return aliases;
}

function validateControlEndpoint(
  configuration: DockerHandsConfiguration,
  endpoint: { address: string; port: number } | undefined,
  aliases: string[],
): void {
  if (endpoint?.port !== 53) {
    return;
  }
  // Actual listener facts override a declared non-53 inventory; DNS cannot become a control exception.
  const brainAddresses = Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).map((entry) => entry.address),
  );
  const addresses = [endpoint.address, ...brainAddresses, ...aliases];
  if (configuration.network?.dnsServers.some((server) => addresses.includes(server)) === true) {
    throw new SeptError("DNS overlaps the actual protected control listener on port 53");
  }
}

function normalizedFilter(value: string): string {
  return (
    value
      .split("\n")
      .filter((line) => !line.startsWith("#") && line.length > 0)
      .map((line) => line.replace(/\[\d+:\d+\]/g, "[0:0]"))
      .join("\n") + "\n"
  );
}
/** Refuse missing, changed or wider firewall authority before an external effect; no configuration promises suffice. */
export async function validateNetworkEnforcement(
  configuration: DockerHandsConfiguration,
  inspectedValue?: unknown,
  controlEndpoint?: { address: string; port: number },
  supplied?: DockerEngineControl,
): Promise<void> {
  if (configuration.network === undefined) {
    return;
  }
  const engine = supplied ?? (await DockerEngineControl.open(configuration.engineSocket));
  try {
    const inspected = handsRecord(
      inspectedValue ?? (await engine.inspect(configuration.containerId)),
    );
    validateControlEndpoint(configuration, controlEndpoint, []);
    const aliases = await validateHostAliases(configuration, engine);
    validateControlEndpoint(configuration, controlEndpoint, aliases);
    for (const family of ["ipv4", "ipv6"] as const) {
      const program = family === "ipv4" ? "/usr/sbin/iptables-save" : "/usr/sbin/ip6tables-save";
      const actual = await engine.exec(configuration.containerId, {
        privileged: true,
        user: "0:0",
        command: [program, "-t", "filter"],
        maximum: 16 * 1024,
      });
      if (normalizedFilter(actual) !== networkFirewall(configuration, inspected, family)) {
        throw new SeptError("Supplied kernel network exclusions are absent or changed");
      }
    }
  } finally {
    if (supplied === undefined) {
      await engine.close();
    }
  }
}
