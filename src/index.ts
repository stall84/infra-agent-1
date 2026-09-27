import ollama, { type Message, type Tool } from "ollama";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTools, createAwsTools } from "./tools.js";

const execFileAsync = promisify(execFile);

// Fire a macOS notification when a run finishes; best-effort only (no-op on
// other platforms, never throws so it can't take down the agent loop).
async function notify(title: string, message: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
    await execFileAsync("osascript", ["-e", script]);
  } catch {
    // Notifications are a convenience, not a requirement.
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_MD_PATH = path.join(__dirname, "..", "AGENT.md");

// The sandbox root: everything the agent's tools touch is confined here.
// Defaults to this project, but can be pointed at another project to test:
//   npm run dev -- /path/to/other/project ["optional task description"]
const rootDir = path.resolve(process.argv[2] ?? process.cwd());
const taskDescription =
  process.argv[3] ??
  "Inspect this project, figure out an appropriate way to test it (e.g. run its test " +
    "suite or build), run that verification, and report the results honestly.";

console.log(`Project root (sandboxed): ${rootDir}`);

const systemPrompt = await readFile(AGENT_MD_PATH, "utf8");

const {
  listFiles,
  readTextFile,
  writeTextFile,
  runCommand,
  listFilesTool,
  readFileTool,
  writeFileTool,
  runCommandTool,
} = createTools(rootDir);

const tools: Tool[] = [listFilesTool, readFileTool, writeFileTool, runCommandTool] as Tool[];

// ------------------------------------------------------------
// AWS credentials are read directly off disk here, in host code the model
// never executes -- they must never be exposed to the model via a tool
// result (which is why read_file refuses to open .env files).
// ------------------------------------------------------------
let awsTools: ReturnType<typeof createAwsTools> | undefined;

const envPath = path.join(rootDir, ".env");
if (existsSync(envPath)) {
  const env = parseEnv(readFileSync(envPath, "utf8"));
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const region = env.AWS_REGION;
  const resourcePrefix = env.TF_VAR_resource_prefix;

  if (accessKeyId && secretAccessKey && region && resourcePrefix) {
    awsTools = createAwsTools({ region, accessKeyId, secretAccessKey, resourcePrefix });
    tools.push(awsTools.listS3BucketsTool, awsTools.createS3BucketTool);
    console.log(`AWS S3 tools enabled (region=${region}, prefix="${resourcePrefix}").`);
  } else {
    console.log("AWS credentials in .env are incomplete; S3 tools disabled for this run.");
  }
} else {
  console.log("No .env found; S3 tools disabled for this run.");
}

const messages: Message[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: taskDescription },
];

const MAX_ITERATIONS = 15;
let finishedCleanly = false;
const createdBuckets: string[] = [];
const writtenFiles: string[] = [];

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n========== AGENT ITERATION ${iteration} ==========\n`);

  // ------------------------------------------------------------
  // Ask the model what it wants to do next.
  // ------------------------------------------------------------

  const response = await ollama.chat({
    model: "qwen3-coder:30b",
    messages,
    tools,
    think: false,
  });

  messages.push(response.message);

  console.log("MODEL CONTENT:");
  console.log(response.message.content);

  // ------------------------------------------------------------
  // Did the model request any tools?
  // ------------------------------------------------------------

  const toolCalls = response.message.tool_calls ?? [];

  if (toolCalls.length === 0) {
    // No tools requested means the model considers itself done.
    console.log("\n========== AGENT FINISHED ==========\n");
    finishedCleanly = true;
    break;
  }

  // ------------------------------------------------------------
  // Execute every tool the model requested.
  // ------------------------------------------------------------

  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name;
    const args = toolCall.function.arguments as Record<string, unknown>;

    console.log(`\nTOOL REQUEST: ${toolName}`);
    console.dir(args, { depth: null });

    let content: string;

    try {
      switch (toolName) {
        case "list_files": {
          const result = await listFiles(args.path as string);
          content = JSON.stringify(result);
          break;
        }
        case "read_file": {
          const result = await readTextFile(args.path as string);
          content = JSON.stringify({ content: result });
          break;
        }
        case "write_file": {
          const result = await writeTextFile(
            args.path as string,
            args.content as string
          );
          writtenFiles.push(result.path);
          content = JSON.stringify(result);
          break;
        }
        case "run_command": {
          const result = await runCommand(
            args.executable as string,
            args.args as string[]
          );
          content = JSON.stringify(result);
          break;
        }
        case "list_s3_buckets": {
          if (!awsTools) throw new Error("AWS S3 tools are not enabled for this run.");
          const result = await awsTools.listS3Buckets();
          content = JSON.stringify(result);
          break;
        }
        case "create_s3_bucket": {
          if (!awsTools) throw new Error("AWS S3 tools are not enabled for this run.");
          const bucketOptions: { blockPublicAccess?: boolean; enableEncryption?: boolean } = {};
          if (typeof args.blockPublicAccess === "boolean") bucketOptions.blockPublicAccess = args.blockPublicAccess;
          if (typeof args.enableEncryption === "boolean") bucketOptions.enableEncryption = args.enableEncryption;
          const result = await awsTools.createS3Bucket(args.bucketName as string, bucketOptions);
          createdBuckets.push(args.bucketName as string);
          content = JSON.stringify(result);
          break;
        }
        default: {
          content = JSON.stringify({ error: `Unknown tool: ${toolName}` });
        }
      }
    } catch (err) {
      // Surface sandbox/allow-list/AWS violations to the model as a tool error
      // rather than crashing the agent loop.
      const message = err instanceof Error ? err.message : String(err);
      content = JSON.stringify({ error: message });
    }

    console.log("\nTOOL RESULT:");
    console.log(content);

    messages.push({
      role: "tool",
      tool_name: toolName,
      content,
    });
  }
}

if (!finishedCleanly) {
  console.log(
    `\n========== STOPPED: reached MAX_ITERATIONS (${MAX_ITERATIONS}) without the model finishing ==========\n`
  );
}

const summaryLines = [
  finishedCleanly ? "Finished cleanly." : "Stopped at max iterations.",
  createdBuckets.length > 0 ? `Buckets: ${createdBuckets.join(", ")}` : undefined,
  writtenFiles.length > 0 ? `Files: ${writtenFiles.join(", ")}` : undefined,
].filter(Boolean);

await notify("infra-coder run complete", summaryLines.join(" \u2014 "));
