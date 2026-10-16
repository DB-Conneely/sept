import { createWorker } from "sept-agent";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} explicitly`);
  }
  return value;
}

const stopped = Promise.withResolvers();
const requestStop = () => stopped.resolve();
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);
let worker;
try {
  worker = await createWorker({
    stateRoot: required("SEPT_STATE_DIR"),
    agentDir: required("PI_CODING_AGENT_DIR"),
    workspaceRoot: required("SEPT_WORKSPACE_ROOT"),
    handsConfigurationPath: required("SEPT_HANDS_CONFIGURATION"),
    token: required("SEPT_TOKEN"),
    host: "127.0.0.1",
    port: 0,
  });
  console.log(JSON.stringify({ baseUrl: `http://${worker.address.host}:${worker.address.port}` }));
  await stopped.promise;
} finally {
  try {
    await worker?.stop();
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  }
}
