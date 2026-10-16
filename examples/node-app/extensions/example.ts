import { SeptError } from "sept-agent";
import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const marker = defineTool({
  name: "write_marker",
  description: "Write the requested marker to the operator-approved hands workspace",
  parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 128 }) }),
  replay: "unsafe",
  outputLimits: { maxBytes: 256, maxLines: 4 },
  async execute(args, api, context): Promise<ToolExecutionResult> {
    if (api.env === undefined) {
      throw new SeptError("This tool requires the supplied native environment");
    }
    const result = await api.env.writeFile("/workspace/native-marker.txt", args.text, context);
    if (!result.ok) {
      throw result.error;
    }
    return { content: [{ type: "text", text: "Marker written through supplied hands." }] };
  },
});

/** Trusted application brain code; only the requested env effect uses hands authority. */
export const extension = defineExtension({
  name: "example-marker",
  tools: [marker],
  sections: [
    section(
      "example-marker",
      () =>
        "SEPT_NATIVE_EXAMPLE_SECTION_V1: Use write_marker only for the explicitly requested marker.",
    ),
  ],
});
