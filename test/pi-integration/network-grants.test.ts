/** Independent network authority remains exact, durable and visible in native call schemas. */
import assert from "node:assert/strict";
import test from "node:test";
import { networkInterfaces } from "node:os";
import { SeptError, type CapabilityPolicy } from "../../src/durable/index.js";
import { admitApprovedCapabilityRequest } from "../../src/execution/capability-admission.js";
import {
  admitCapabilityRequest,
  defaultCapabilities,
  validateCapabilities,
} from "../../src/execution/index.js";
import {
  parseNetworkConfiguration,
  validateNetworkProfile,
  networkFirewall,
} from "../../src/execution/network-profile.js";
import { validateLiveHands } from "../../src/execution/hands-live-authority.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { suppliedEngine } from "./backend-support.js";
import { validateNetworkEnforcement } from "../../src/execution/network-enforcement.js";
import { guardedCommand } from "../../src/execution/hands-processes.js";
import { createDurableCodingTools } from "../../src/pi-integration/durable-tools.js";
import { fixtureDirectories } from "./support.js";
import { FixtureExecutionBackend } from "./backend-support.js";

const network = {
  networkId: "b".repeat(64),
  protectedAddresses: [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? []).map((entry) => entry.address),
      ),
    ),
  ],
  dnsServers: ["1.1.1.1"],
};
function configuration() {
  return {
    profile: "docker-linux-warm-v1" as const,
    dataDomain: "private" as const,
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    engineSocket: "/run/docker.sock",
    containerId: "a".repeat(64),
    generation: "fresh",
    workspace: "/workspace",
    resources: "/resources",
    shell: true,
    readOnlyMounts: [],
    network,
  };
}
function policy(): CapabilityPolicy {
  return {
    ...defaultCapabilities(),
    execute: true,
    version: 1,
    revision: 1,
    denied: false,
    binding: { containerId: "a".repeat(64), generation: "fresh", fingerprint: "c".repeat(64) },
  };
}
function inspection(dnsServers = network.dnsServers) {
  return {
    HostConfig: { NetworkMode: network.networkId, Dns: dnsServers, PortBindings: {} },
    NetworkSettings: {
      Networks: {
        consumer: {
          NetworkID: network.networkId,
          Gateway: "198.18.42.1",
          IPAddress: "198.18.42.5",
          IPv6Gateway: "2001:db8:42::1",
          GlobalIPv6Address: "2001:db8:42::5",
        },
      },
    },
  };
}
void test("network configuration accepts legitimate private DNS while refusing special and ambiguous endpoints", () => {
  assert.deepEqual(parseNetworkConfiguration(network), network);
  for (const dnsServers of [["10.20.30.53"], ["100.96.0.53"], ["fd42::53"]]) {
    assert.deepEqual(parseNetworkConfiguration({ ...network, dnsServers }).dnsServers, dnsServers);
  }
  for (const mutation of [
    { dnsServers: ["127.0.0.1"] },
    { dnsServers: ["::ffff:172.17.0.1"] },
    { dnsServers: ["::"] },
    { dnsServers: ["ff02::1"] },
    { dnsServers: ["::ffff:1.1.1.1"] },
    { dnsServers: ["fd00:ec2::254"] },
    { dnsServers: ["fd20:ce::254"] },
    { dnsServers: ["100.100.100.200"] },
    { networkId: "host" },
    { protectedAddresses: ["brain.example"] },
    { extra: true },
  ]) {
    assert.throws(() => parseNetworkConfiguration({ ...network, ...mutation }), SeptError);
  }
});
void test("a shared protected DNS address requires complete non-DNS protected service facts", () => {
  const shared = { ...network, protectedAddresses: ["10.20.30.1"], dnsServers: ["10.20.30.1"] };
  assert.throws(() => parseNetworkConfiguration(shared), SeptError);
  assert.throws(() => parseNetworkConfiguration({ ...shared, protectedEndpoints: [] }), SeptError);
  assert.throws(
    () =>
      parseNetworkConfiguration({
        ...shared,
        protectedEndpoints: [{ address: "10.20.30.1", port: 53 }],
      }),
    SeptError,
  );
  assert.deepEqual(
    parseNetworkConfiguration({
      ...shared,
      protectedEndpoints: [{ address: "10.20.30.1", port: 8090 }],
    }).protectedEndpoints,
    [{ address: "10.20.30.1", port: 8090 }],
  );
  for (const port of [0, 65536, 1.5, "53"]) {
    assert.throws(
      () =>
        parseNetworkConfiguration({
          ...shared,
          protectedEndpoints: [{ address: "10.20.30.1", port }],
        }),
      SeptError,
    );
  }
});
void test("network is explicit in every mode and an exact approved network retry adds only its missing rights", () => {
  const configured = configuration();
  assert.equal(
    validateCapabilities({ ...defaultCapabilities(), mode: "full_access" }, configured).network,
    false,
  );
  assert.equal(
    validateCapabilities({ ...defaultCapabilities(), network: true }, configured).network,
    true,
  );
});
void test("exact network approval checks the call intent and keeps file-only commands ungranted", () => {
  const configured = configuration();
  const request = {
    kind: "tool" as const,
    name: "bash" as const,
    callId: "exact",
    arguments: { command: "network effect", network: true },
  };
  assert.throws(
    () => admitCapabilityRequest(policy(), request, "/workspace", configured),
    /Network capability/,
  );
  assert.equal(
    admitApprovedCapabilityRequest(
      { ...policy(), mode: "request_approval" },
      request,
      "/workspace",
      configured,
    ).kind,
    "tool",
  );
  assert.throws(
    () =>
      admitCapabilityRequest(
        policy(),
        { ...request, arguments: { network: "true" } },
        "/workspace",
        configured,
      ),
    /boolean/,
  );
});
void test("file-only command arguments retain the denied network default", () => {
  const configured = configuration();
  const request = {
    kind: "tool" as const,
    name: "bash" as const,
    callId: "exact",
    arguments: { command: "file only" },
  };
  assert.equal(admitCapabilityRequest(policy(), request, "/workspace", configured).kind, "tool");
});
void test("trusted dispatch defaults to inherited socket denial and enables only selected network intent", () => {
  assert.ok(guardedCommand(["--eval", "0"], { network: false }).includes("SEPT_HANDS_NETWORK=0"));
  assert.ok(guardedCommand(["--eval", "0"], { network: true }).includes("SEPT_HANDS_NETWORK=1"));
});
void test("actual topology excludes private brain interfaces and metadata without denying ordinary private peers", async () => {
  const configured = configuration();
  const inspected = inspection();
  validateNetworkProfile(configured, inspected);
  assert.throws(() => {
    validateNetworkProfile(configured, {
      ...inspected,
      HostConfig: { ...inspected.HostConfig, NetworkMode: "host" },
    });
  }, SeptError);
  assert.match(networkFirewall(configured, inspected, "ipv4"), /169\.254\.0\.0\/16 -j DROP/);
  assert.match(networkFirewall(configured, inspected, "ipv4"), /198\.18\.42\.1\/32 -j DROP/);
  const ipv4 = networkFirewall(configured, inspected, "ipv4");
  const ipv6 = networkFirewall(configured, inspected, "ipv6");
  assert.doesNotMatch(
    ipv4,
    /(?:10\.0\.0\.0\/8|100\.64\.0\.0\/10|172\.16\.0\.0\/12|192\.168\.0\.0\/16) -j DROP/,
  );
  assert.doesNotMatch(ipv6, /fc00::\/7 -j DROP/);
  assert.match(ipv4, /100\.100\.100\.200\/32 -j DROP/);
  assert.match(ipv6, /fd00:ec2::254\/128 -j DROP/);
  assert.match(ipv6, /fd20:ce::254\/128 -j DROP/);
  assert.match(networkFirewall(configured, inspected, "ipv6"), /2001:db8:42::1\/128 -j DROP/);
  assert.throws(() => {
    validateNetworkProfile(
      { ...configured, network: { ...network, protectedAddresses: [] } },
      inspected,
    );
  }, SeptError);
  await assert.rejects(validateNetworkEnforcement(configured), SeptError);
});
void test("shared gateway DNS permits only UDP/TCP destination 53 before all-port gateway denial", () => {
  const configured = {
    ...configuration(),
    network: {
      ...network,
      dnsServers: ["10.20.30.1"],
      protectedEndpoints: [{ address: "10.20.30.1", port: 8090 }],
    },
  };
  const inspected = inspection(configured.network.dnsServers);
  inspected.NetworkSettings.Networks.consumer.Gateway = "10.20.30.1";
  inspected.NetworkSettings.Networks.consumer.IPAddress = "10.20.30.5";
  validateNetworkProfile(configured, inspected);
  const filter = networkFirewall(configured, inspected, "ipv4");
  const denial = filter.indexOf("-A OUTPUT -d 10.20.30.1/32 -j DROP");
  for (const protocol of ["udp", "tcp"]) {
    const allowance = filter.indexOf(
      `-A OUTPUT -d 10.20.30.1/32 -p ${protocol} -m ${protocol} --dport 53 -j ACCEPT`,
    );
    assert.ok(allowance >= 0 && allowance < denial);
  }
  assert.throws(() => {
    validateNetworkProfile(
      { ...configured, network: { ...configured.network, protectedEndpoints: [] } },
      inspected,
    );
  }, SeptError);
  assert.throws(() => {
    validateNetworkProfile(
      {
        ...configured,
        network: {
          ...configured.network,
          protectedEndpoints: [{ address: "10.20.30.1", port: 53 }],
        },
      },
      inspected,
    );
  }, SeptError);
});
void test("installed native Bash schema accepts explicit bounded network intent without replacing its command body", () => {
  const directories = fixtureDirectories("sept-network-schema-");
  const tools = createDurableCodingTools(new FixtureExecutionBackend(directories.workspace)).tools;
  const bash = tools?.find((entry) => entry.name === "bash");
  assert.ok(bash);
  assert.match(JSON.stringify(bash.parameters), /Explicitly request network access/);
  assert.match(JSON.stringify(bash.parameters), /Shell command to execute/);
});

void test("validateLiveHands refuses changed generation before any privileged network probe", async () => {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  try {
    await assert.rejects(
      validateLiveHands(
        { ...configuration(), engineSocket: fixture.path },
        engine,
        { kind: "file", method: "readTextFile", path: "file.txt" },
        { workspace: fixture.root, brainRoots: [], policyPath: fixture.root },
      ),
      SeptError,
    );
    assert.equal(fixture.facts.execStarts, 0);
  } finally {
    await engine.close();
    await fixture.close();
  }
});
