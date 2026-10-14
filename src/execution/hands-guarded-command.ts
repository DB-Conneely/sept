/** Immutable guard/environment composition shared by resident and fixed trusted helpers. */
// env -i excludes a forged marker; only the immutable constructor acknowledges kernel protection.
const GUARD_PRELOAD =
  "data:text/javascript," +
  encodeURIComponent(
    "if (process.env.SEPT_HANDS_PROCESS_GUARD !== '2' || !['denied', 'granted'].includes(process.env.SEPT_HANDS_NETWORK_GUARD)) process.exit(126);",
  );
const GUARDED_ENV = [
  "/usr/bin/env",
  "-i",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/home/sept-hands",
  "PI_CODING_AGENT_DIR=/home/sept-hands/.pi/agent",
  "TMPDIR=/tmp",
  "PI_OFFLINE=1",
  "LD_PRELOAD=/app/hands-guard.so",
];
const GUARDED_NODE = ["node", "--disable-sigusr1", "--import", GUARD_PRELOAD];

/** Fixed image Node/guard/environment only; trusted composition supplies the executable arguments. */
export function guardedCommand(
  arguments_: string[],
  rights: { network: boolean } = { network: false },
): string[] {
  return [
    ...GUARDED_ENV,
    `SEPT_HANDS_NETWORK=${rights.network ? "1" : "0"}`,
    ...GUARDED_NODE,
    ...arguments_,
  ];
}
