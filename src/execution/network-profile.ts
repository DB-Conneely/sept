/** Explicit network grants permit ordinary private peers while retaining exact brain exclusions. */
import { isIP, BlockList } from "node:net";
import { networkInterfaces } from "node:os";
import { SeptError } from "../durable/index.js";
import type { DockerHandsConfiguration } from "./contracts.js";
import { handsRecord } from "./protocol.js";

type NetworkConfiguration = NonNullable<DockerHandsConfiguration["network"]>;
const SPECIAL_V4 = [
  "0.0.0.0/8",
  "100.100.100.200/32",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
const SPECIAL_V6 = [
  "::/96",
  "::1/128",
  "::ffff:0.0.0.0/96",
  "fd00:ec2::254/128",
  "fd20:ce::254/128",
  "fe80::/10",
  "ff00::/8",
];

// Docker DNATs this engine-owned resolver to ephemeral ports before filter; only its established replies
// may return to work-owned loopback clients. Other loopback/control destinations stay denied.
const RESOLVER_RULES = [
  "-A INPUT -d 127.0.0.11/32 -p tcp -m conntrack --ctorigdst 127.0.0.11 --ctorigdstport 53 --ctdir ORIGINAL -j ACCEPT",
  "-A INPUT -d 127.0.0.11/32 -p udp -m conntrack --ctorigdst 127.0.0.11 --ctorigdstport 53 --ctdir ORIGINAL -j ACCEPT",
  "-A OUTPUT -d 127.0.0.11/32 -p tcp -m conntrack --ctorigdst 127.0.0.11 --ctorigdstport 53 --ctdir ORIGINAL -j ACCEPT",
  "-A OUTPUT -d 127.0.0.11/32 -p udp -m conntrack --ctorigdst 127.0.0.11 --ctorigdstport 53 --ctdir ORIGINAL -j ACCEPT",
  "-A OUTPUT -s 127.0.0.11/32 -p tcp -m conntrack --ctstate ESTABLISHED --ctorigdst 127.0.0.11 --ctorigdstport 53 --ctdir REPLY -j ACCEPT",
  "-A OUTPUT -s 127.0.0.11/32 -p udp -m conntrack --ctstate ESTABLISHED --ctorigdst 127.0.0.11 --ctorigdstport 53 --ctdir REPLY -j ACCEPT",
];
// Actual IPv6 needs kernel neighbor discovery; dropped RAW capabilities prevent command-forged NDP.
const NEIGHBOUR_RULES = [
  "-A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 135 -j ACCEPT",
  "-A INPUT -p ipv6-icmp -m icmp6 --icmpv6-type 136 -j ACCEPT",
  "-A OUTPUT -p ipv6-icmp -m icmp6 --icmpv6-type 135 -j ACCEPT",
  "-A OUTPUT -p ipv6-icmp -m icmp6 --icmpv6-type 136 -j ACCEPT",
];

function address(value: unknown): string {
  if (typeof value !== "string" || value.length > 45 || isIP(value) === 0) {
    throw new SeptError("Network exclusion must be an IP address");
  }
  const canonical = isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value;
  if (canonical.startsWith("::ffff:")) {
    throw new SeptError("Network inventory must use the original IPv4 address, not a mapped alias");
  }
  return canonical;
}
function addresses(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new SeptError("Network addresses exceed their bound");
  }
  const result = value.map((entry: unknown) => address(entry));
  if (new Set(result).size !== result.length) {
    throw new SeptError("Network addresses must be unique");
  }
  return result;
}
function specialAddress(value: string): boolean {
  const denied = new BlockList();
  // BlockList maps IPv4 into IPv6; keep the families separate so mapped denial cannot deny all IPv4.
  for (const subnet of isIP(value) === 4 ? SPECIAL_V4 : SPECIAL_V6) {
    const [base = "", prefix = ""] = subnet.split("/");
    denied.addSubnet(base, Number(prefix), isIP(base) === 4 ? "ipv4" : "ipv6");
  }
  return denied.check(value, isIP(value) === 4 ? "ipv4" : "ipv6");
}
function protectedEndpoints(value: unknown): NetworkConfiguration["protectedEndpoints"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 64) {
    throw new SeptError("Protected network endpoints exceed their bound");
  }
  const endpoints = value.map((entry: unknown) => {
    const input = handsRecord(entry);
    if (
      Object.keys(input).some((key) => key !== "address" && key !== "port") ||
      typeof input.port !== "number" ||
      !Number.isSafeInteger(input.port) ||
      input.port < 1 ||
      input.port > 65535
    ) {
      throw new SeptError("Protected network endpoint is malformed");
    }
    return { address: address(input.address), port: input.port };
  });
  if (
    new Set(endpoints.map((entry) => `${entry.address}:${String(entry.port)}`)).size !==
    endpoints.length
  ) {
    throw new SeptError("Protected network endpoints must be unique");
  }
  return endpoints;
}
/** Decode complete bounded trusted aliases; private DNS is permitted, metadata and ambiguous overlaps refuse. */
export function parseNetworkConfiguration(value: unknown): NetworkConfiguration {
  const input = handsRecord(value);
  if (
    typeof input.networkId !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.networkId) ||
    Object.keys(input).some(
      (key) =>
        !["networkId", "protectedAddresses", "dnsServers", "protectedEndpoints"].includes(key),
    )
  ) {
    throw new SeptError("Supplied network identity is malformed");
  }
  const protectedAddresses = addresses(input.protectedAddresses, 32);
  const dnsServers = addresses(input.dnsServers, 2);
  const endpoints = protectedEndpoints(input.protectedEndpoints);
  if (dnsServers.length === 0 || dnsServers.some((entry) => specialAddress(entry))) {
    throw new SeptError("Network DNS must exclude special and metadata destinations");
  }
  const network = {
    networkId: input.networkId,
    protectedAddresses,
    dnsServers,
    ...(endpoints === undefined ? {} : { protectedEndpoints: endpoints }),
  };
  assertDnsOverlaps(network, protectedAddresses);
  return network;
}
/** Enforce exact attachment/DNS and require every reachable public/private brain interface to be excluded. */
export function validateNetworkProfile(
  configuration: DockerHandsConfiguration,
  inspected: Record<string, unknown>,
): void {
  const host = handsRecord(inspected.HostConfig);
  if (configuration.network === undefined) {
    if (host.NetworkMode !== "none") {
      throw new SeptError("Ungrantable hands namespace must use network none");
    }
    return;
  }
  validateAttachment(configuration.network, inspected);
  assertBrainExclusions(configuration.network);
  const excluded = [
    ...endpointAddresses(inspected, "ipv4"),
    ...endpointAddresses(inspected, "ipv6"),
  ];
  assertDnsOverlaps(configuration.network, excluded);
}
function validateAttachment(
  network: NetworkConfiguration,
  inspected: Record<string, unknown>,
): void {
  const host = handsRecord(inspected.HostConfig);
  const attached = handsRecord(handsRecord(inspected.NetworkSettings).Networks);
  const endpoints = Object.values(attached).map((value) => handsRecord(value));
  if (
    host.NetworkMode !== network.networkId ||
    endpoints.length !== 1 ||
    endpoints[0]?.NetworkID !== network.networkId ||
    JSON.stringify(host.Dns) !== JSON.stringify(network.dnsServers) ||
    Object.keys(handsRecord(host.PortBindings ?? {})).length !== 0
  ) {
    throw new SeptError("Connected hands namespace differs from the supplied network contract");
  }
}
function assertBrainExclusions(network: NetworkConfiguration): void {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (
        !entry.internal &&
        !specialAddress(entry.address) &&
        !network.protectedAddresses.includes(address(entry.address))
      ) {
        throw new SeptError("Brain interface is absent from network exclusions");
      }
    }
  }
}
function assertDnsOverlaps(network: NetworkConfiguration, excluded: string[]): void {
  for (const server of network.dnsServers) {
    const endpoints = (network.protectedEndpoints ?? []).filter(
      (entry) => entry.address === server,
    );
    const overlap = excluded.includes(server) || endpoints.length > 0;
    if (endpoints.some((entry) => entry.port === 53)) {
      throw new SeptError("DNS overlaps a protected service on port 53");
    }
    if (overlap && endpoints.length === 0) {
      throw new SeptError("Shared DNS address requires a complete protected endpoint inventory");
    }
  }
}
function endpointAddresses(inspected: Record<string, unknown>, family: "ipv4" | "ipv6"): string[] {
  const endpoints = Object.values(handsRecord(handsRecord(inspected.NetworkSettings).Networks)).map(
    (value) => handsRecord(value),
  );
  const fields =
    family === "ipv4" ? ["Gateway", "IPAddress"] : ["IPv6Gateway", "GlobalIPv6Address"];
  return endpoints
    .flatMap((endpoint) => fields.map((field) => endpoint[field]))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => address(value));
}
function excludedAddresses(
  network: NetworkConfiguration,
  inspected: Record<string, unknown>,
  family: "ipv4" | "ipv6",
): string[] {
  const version = family === "ipv4" ? 4 : 6;
  return [
    ...(version === 4 ? SPECIAL_V4 : SPECIAL_V6),
    ...[
      ...new Set([
        ...network.protectedAddresses,
        ...(network.protectedEndpoints ?? []).map((entry) => entry.address),
        ...endpointAddresses(inspected, family),
      ]),
    ]
      .filter((entry) => isIP(entry) === version)
      .map((entry) => `${address(entry)}/${version === 4 ? "32" : "128"}`),
  ];
}
/** Construct only the exact filter table consumers must install; network gateways and self addresses stay excluded. */
export function networkFirewall(
  configuration: DockerHandsConfiguration,
  inspected: Record<string, unknown>,
  family: "ipv4" | "ipv6",
): string {
  const network = configuration.network;
  if (network === undefined) {
    throw new SeptError("A supplied network contract is required");
  }
  const version = family === "ipv4" ? 4 : 6;
  const excluded = excludedAddresses(network, inspected, family);
  assertDnsOverlaps(network, [
    ...endpointAddresses(inspected, "ipv4"),
    ...endpointAddresses(inspected, "ipv6"),
  ]);
  // DNS shares only destination 53; every other protected/gateway port remains behind the drops.
  const dnsRules = network.dnsServers
    .filter((server) => isIP(server) === version)
    .flatMap((server) =>
      ["udp", "tcp"].map(
        (protocol) =>
          `-A OUTPUT -d ${server}/${version === 4 ? "32" : "128"} -p ${protocol} -m ${protocol} --dport 53 -j ACCEPT`,
      ),
    );
  return [
    "*filter",
    ":INPUT DROP [0:0]",
    ":FORWARD DROP [0:0]",
    ":OUTPUT ACCEPT [0:0]",
    "-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
    ...(version === 4 ? RESOLVER_RULES : NEIGHBOUR_RULES),
    ...dnsRules,
    ...excluded.map((entry) => `-A OUTPUT -d ${entry} -j DROP`),
    "COMMIT",
    "",
  ].join("\n");
}
