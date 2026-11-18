// A minimal MCP server over stdio, for tests: one tool, `echo`. Appends its
// pid to the file named by MCP_ECHO_PIDS so a test can see which processes
// were started and whether they are still alive.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.MCP_ECHO_PIDS) appendFileSync(process.env.MCP_ECHO_PIDS, `${process.pid}\n`);

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "1" },
      },
    });
  } else if (method === "tools/list") {
    send({
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Returns its input.",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      },
    });
  } else if (method === "tools/call") {
    send({ id, result: { content: [{ type: "text", text: `echo: ${params.arguments.text}` }] } });
  } else {
    send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
// Exit when the client closes the pipe.
process.stdin.on("end", () => process.exit(0));
