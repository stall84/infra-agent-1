import { readFile, readdir, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import {
  S3Client,
  ListBucketsCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 10_000;
const COMMAND_TIMEOUT_MS = 60_000;

// Credential/secret files the model must never be able to read or overwrite via the
// generic file tools, even though they live inside the sandboxed project root.
const SECRET_FILE_PATTERN = /(^|[\\/])\.env(\.|$)|\.pem$|id_rsa|credentials(\.|$)/i;

function assertNotSecretFile(safePath: string): void {
  if (SECRET_FILE_PATTERN.test(path.basename(safePath))) {
    throw new Error(
      `Refusing to access "${path.basename(safePath)}": it looks like a credentials/secret file, ` +
        `which the file tools are not allowed to read or write.`
    );
  }
}

// Only these executables/subcommands may run, and only inside the sandbox root.
// This intentionally excludes anything that writes history, pushes, or installs
// beyond the project (no commit/push/reset/checkout, no arbitrary shell).
const ALLOWED_COMMANDS: Record<string, Set<string>> = {
  npm: new Set(["test", "run", "install", "ci", "uninstall", "ls", "list", "outdated", "audit", "build", "view"]),
  npx: new Set(["tsc", "vite", "eslint", "prettier", "vitest"]),
  git: new Set(["status", "diff", "log", "show", "branch"]),
};

// Directories never worth listing/searching (huge and irrelevant to the model).
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage"]);
const MAX_READ_CHARS = 40_000;
const MAX_SEARCH_RESULTS = 100;

// "npm run dev" starts this very agent, which would call an LLM that could call
// "npm run dev" again -- an unbounded, resource-consuming recursive spawn.
// Long-running servers (dev/start/preview/serve/watch) never exit and would just hit the
// command timeout, so they are blocked outright; verify with build/test instead.
const BLOCKED_NPM_RUN_SCRIPTS = new Set(["dev", "start", "preview", "serve", "watch"]);

// Blocks shell metacharacters/injection attempts even though execFile never
// spawns a shell; this keeps arguments limited to plausible CLI tokens.
const SAFE_ARG = /^[A-Za-z0-9_.:@/=^~+-]+$/;

/** Resolves a user-supplied path against the sandbox root and rejects escapes. */
function resolveSafePath(rootDir: string, inputPath: string): string {
  const resolved = path.resolve(rootDir, inputPath);
  const rel = path.relative(rootDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to access "${inputPath}": it resolves outside the project root (${rootDir}).`
    );
  }
  return resolved;
}

/**
 * Builds the tool implementations and their Ollama tool-call schemas, all
 * scoped to operate only within `rootDir`.
 */
export function createTools(rootDir: string) {
  async function listFiles(dirPath: string, recursive = false): Promise<string[]> {
    const safePath = resolveSafePath(rootDir, dirPath);
    if (!recursive) {
      const entries = await readdir(safePath, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    }
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) continue;
          await walk(path.join(dir, e.name));
        } else if (out.length < 500) {
          out.push(path.relative(safePath, path.join(dir, e.name)));
        }
      }
    };
    await walk(safePath);
    return out;
  }

  async function readTextFile(
    filePath: string,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    const safePath = resolveSafePath(rootDir, filePath);
    assertNotSecretFile(safePath);
    const text = await readFile(safePath, "utf8");
    if (startLine === undefined && endLine === undefined) {
      if (text.length > MAX_READ_CHARS) {
        return (
          text.slice(0, MAX_READ_CHARS) +
          `\n[truncated at ${MAX_READ_CHARS} chars; re-read with start_line/end_line for the rest]`
        );
      }
      return text;
    }
    const lines = text.split("\n");
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? lines.length);
    return lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}: ${l}`)
      .join("\n");
  }

  async function editTextFile(
    filePath: string,
    oldText: string,
    newText: string
  ): Promise<{ path: string; replaced: number }> {
    const safePath = resolveSafePath(rootDir, filePath);
    assertNotSecretFile(safePath);
    if (!oldText) throw new Error("old_text must not be empty.");
    const text = await readFile(safePath, "utf8");
    const count = text.split(oldText).length - 1;
    if (count === 0) {
      throw new Error("old_text was not found in the file. Re-read the file and copy the text exactly.");
    }
    if (count > 1) {
      throw new Error(
        `old_text matches ${count} places; include more surrounding context so it matches exactly once.`
      );
    }
    await writeFile(safePath, text.replace(oldText, () => newText), "utf8");
    return { path: path.relative(rootDir, safePath), replaced: 1 };
  }

  async function deleteTextFile(filePath: string): Promise<{ path: string; deleted: true }> {
    const safePath = resolveSafePath(rootDir, filePath);
    assertNotSecretFile(safePath);
    if (safePath === rootDir) throw new Error("Refusing to delete the project root.");
    const info = await stat(safePath);
    if (info.isDirectory()) {
      throw new Error("delete_file only deletes single files, not directories.");
    }
    await rm(safePath);
    return { path: path.relative(rootDir, safePath), deleted: true };
  }

  async function searchFiles(
    pattern: string,
    dirPath = "."
  ): Promise<Array<{ file: string; line: number; text: string }>> {
    const safePath = resolveSafePath(rootDir, dirPath);
    const needle = pattern.toLowerCase();
    const results: Array<{ file: string; line: number; text: string }> = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) await walk(full);
        } else if (!SECRET_FILE_PATTERN.test(e.name)) {
          const info = await stat(full);
          if (info.size > 1_000_000) continue;
          const buf = await readFile(full);
          if (buf.includes(0)) continue; // binary
          buf
            .toString("utf8")
            .split("\n")
            .forEach((l, i) => {
              if (results.length < MAX_SEARCH_RESULTS && l.toLowerCase().includes(needle)) {
                results.push({
                  file: path.relative(rootDir, full),
                  line: i + 1,
                  text: l.trim().slice(0, 200),
                });
              }
            });
        }
      }
    };
    await walk(safePath);
    return results;
  }

  async function writeTextFile(
    filePath: string,
    content: string
  ): Promise<{ path: string; bytesWritten: number }> {
    const safePath = resolveSafePath(rootDir, filePath);
    assertNotSecretFile(safePath);
    await mkdir(path.dirname(safePath), { recursive: true });
    await writeFile(safePath, content, "utf8");
    return {
      path: path.relative(rootDir, safePath),
      bytesWritten: Buffer.byteLength(content, "utf8"),
    };
  }

  async function runCommand(
    executable: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number | string; error?: string }> {
    const allowedSubcommands = ALLOWED_COMMANDS[executable];
    if (!allowedSubcommands) {
      throw new Error(
        `Executable "${executable}" is not allow-listed. Allowed executables: ${Object.keys(
          ALLOWED_COMMANDS
        ).join(", ")}.`
      );
    }
    const subcommand = args[0];
    if (!subcommand || !allowedSubcommands.has(subcommand)) {
      throw new Error(
        `Subcommand "${subcommand ?? ""}" is not allowed for "${executable}". Allowed: ${[
          ...allowedSubcommands,
        ].join(", ")}.`
      );
    }
    for (const arg of args) {
      if (!SAFE_ARG.test(arg)) {
        throw new Error(`Argument "${arg}" contains disallowed characters.`);
      }
    }
    if (executable === "npm" && subcommand === "run" && args[1] && BLOCKED_NPM_RUN_SCRIPTS.has(args[1])) {
      throw new Error(
        `Running "npm run ${args[1]}" is blocked: it starts a long-running server that never exits. Use "npm run build" or "npm test" to verify instead.`
      );
    }

    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        cwd: rootDir,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return {
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode: 0,
      };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string; message: string };
      return {
        stdout: (e.stdout ?? "").slice(0, MAX_OUTPUT_CHARS),
        stderr: (e.stderr ?? "").slice(0, MAX_OUTPUT_CHARS),
        exitCode: e.code ?? 1,
        error: e.message,
      };
    }
  }

  const listFilesTool = {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List the files and directories in a given directory, relative to the project root. " +
        "Directories end with '/'. Set recursive=true to see the whole tree (skips node_modules, .git, dist, build).",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "The directory path to list, relative to the project root. Use '.' for the root.",
          },
          recursive: {
            type: "boolean",
            description: "List all files in subdirectories too. Defaults to false.",
          },
        },
      },
    },
  };

  const readFileTool = {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read and return the complete text contents of a file. Use this to inspect source code, configuration files, test files, package manifests, or documentation.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "The path of the text file to read, relative to the project root.",
          },
          start_line: {
            type: "number",
            description: "Optional 1-based first line to return (output is prefixed with line numbers).",
          },
          end_line: {
            type: "number",
            description: "Optional 1-based last line to return.",
          },
        },
      },
    },
  };

  const writeFileTool = {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file within the project root. Use this to add or edit test scripts, fixtures, or notes. Cannot write outside the project root.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: {
            type: "string",
            description: "The file path to write, relative to the project root.",
          },
          content: {
            type: "string",
            description: "The full text content to write to the file.",
          },
        },
      },
    },
  };

  const editFileTool = {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit an existing file by replacing one exact occurrence of old_text with new_text. Prefer this over " +
        "write_file for small changes to existing files. old_text must match the file exactly (including " +
        "whitespace) and appear exactly once; add surrounding lines for uniqueness.",
      parameters: {
        type: "object",
        required: ["path", "old_text", "new_text"],
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
          old_text: { type: "string", description: "Exact existing text to replace." },
          new_text: { type: "string", description: "Replacement text." },
        },
      },
    },
  };

  const deleteFileTool = {
    type: "function",
    function: {
      name: "delete_file",
      description:
        "Delete a single file inside the project root (e.g. an obsolete component). Cannot delete directories.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
        },
      },
    },
  };

  const searchFilesTool = {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Case-insensitive plain-text search across files (skips node_modules, .git, dist, build, binaries, and " +
        "secret files). Returns up to 100 matches as file/line/text. Use it to find where something is defined or used.",
      parameters: {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: { type: "string", description: "Text to search for." },
          path: {
            type: "string",
            description: "Directory to search, relative to the project root. Defaults to '.'.",
          },
        },
      },
    },
  };

  const runCommandTool = {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run an allow-listed command inside the project root to build, test, or inspect the project. " +
        "Allowed: 'npm' (test/run/install/ci/uninstall/ls/list/outdated/audit/build/view), 'npx' (tsc/vite/eslint/prettier/vitest), " +
        "and read-only 'git' (status/diff/log/show/branch). Long-running servers (npm run dev/start/preview) are blocked; " +
        "verify with 'npm run build' and 'npm test'. Cannot run arbitrary shell commands or mutate git history.",
      parameters: {
        type: "object",
        required: ["executable", "args"],
        properties: {
          executable: {
            type: "string",
            enum: Object.keys(ALLOWED_COMMANDS),
            description: "The base executable to run.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description:
              'Arguments to pass, e.g. ["test"], ["run", "build"], or ["status"]. First element must be an allowed subcommand.',
          },
        },
      },
    },
  };

  return {
    listFiles,
    readTextFile,
    writeTextFile,
    editTextFile,
    deleteTextFile,
    searchFiles,
    runCommand,
    listFilesTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    deleteFileTool,
    searchFilesTool,
    runCommandTool,
  };
}

export interface AwsToolsConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Bucket names must start with this prefix so the agent can never touch
  // pre-existing/unrelated AWS resources in the account.
  resourcePrefix: string;
}

/**
 * Builds AWS S3 tool implementations and their Ollama tool-call schemas, scoped to the
 * given credentials/region and constrained to bucket names starting with `resourcePrefix`.
 */
export function createAwsTools(config: AwsToolsConfig) {
  const s3 = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  function assertValidBucketName(name: string): void {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) || name.includes("..")) {
      throw new Error(
        `"${name}" is not a valid S3 bucket name (3-63 chars, lowercase letters/digits/hyphens/dots, ` +
          `must start and end with a letter or digit, no consecutive dots).`
      );
    }
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) {
      throw new Error(`"${name}" is not a valid S3 bucket name: it looks like an IP address.`);
    }
    if (!name.startsWith(config.resourcePrefix)) {
      throw new Error(
        `Refusing to create bucket "${name}": bucket names must start with the configured resource ` +
          `prefix "${config.resourcePrefix}" so the agent cannot touch unrelated AWS resources.`
      );
    }
  }

  async function bucketExists(bucketName: string): Promise<boolean> {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) {
        return false;
      }
      // 403 (forbidden) or anything else: surface the real error instead of guessing.
      throw err;
    }
  }

  async function listS3Buckets(): Promise<Array<{ name: string; creationDate: string | null }>> {
    const result = await s3.send(new ListBucketsCommand({}));
    return (result.Buckets ?? []).map((b) => ({
      name: b.Name ?? "",
      creationDate: b.CreationDate ? b.CreationDate.toISOString() : null,
    }));
  }

  async function createS3Bucket(
    bucketName: string,
    options: { blockPublicAccess?: boolean; enableEncryption?: boolean } = {}
  ): Promise<{
    bucketName: string;
    region: string;
    created: boolean;
    alreadyExisted: boolean;
    publicAccessBlocked: boolean;
    encryptionEnabled: boolean;
  }> {
    const blockPublicAccess = options.blockPublicAccess ?? true;
    const enableEncryption = options.enableEncryption ?? true;

    assertValidBucketName(bucketName);
    const alreadyExisted = await bucketExists(bucketName);

    if (!alreadyExisted) {
      await s3.send(
        new CreateBucketCommand({
          Bucket: bucketName,
          ...(config.region === "us-east-1"
            ? {}
            : {
                CreateBucketConfiguration: {
                  LocationConstraint: config.region as BucketLocationConstraint,
                },
              }),
        })
      );
    }

    if (blockPublicAccess) {
      await s3.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucketName,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        })
      );
    }

    if (enableEncryption) {
      await s3.send(
        new PutBucketEncryptionCommand({
          Bucket: bucketName,
          ServerSideEncryptionConfiguration: {
            Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
          },
        })
      );
    }

    await s3.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: {
          TagSet: [
            { Key: "ManagedBy", Value: "infra-coder-1" },
            { Key: "CreatedAt", Value: new Date().toISOString() },
          ],
        },
      })
    );

    return {
      bucketName,
      region: config.region,
      created: !alreadyExisted,
      alreadyExisted,
      publicAccessBlocked: blockPublicAccess,
      encryptionEnabled: enableEncryption,
    };
  }

  const listS3BucketsTool = {
    type: "function",
    function: {
      name: "list_s3_buckets",
      description:
        "List all S3 buckets visible to the configured AWS credentials, across the whole account " +
        "(read-only, safe to call any time).",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  };

  const createS3BucketTool = {
    type: "function",
    function: {
      name: "create_s3_bucket",
      description:
        `Create a new S3 bucket in ${config.region}. The bucket name MUST start with the ` +
        `"${config.resourcePrefix}" prefix (enforced) so the agent cannot create resources outside its ` +
        "sandboxed naming convention. By default the bucket is created with all public access blocked " +
        "and AES256 default encryption enabled. Safe to call repeatedly: if the bucket already exists " +
        "it is left as-is and reported as already existing rather than erroring.",
      parameters: {
        type: "object",
        required: ["bucketName"],
        properties: {
          bucketName: {
            type: "string",
            description: `Bucket name, must start with "${config.resourcePrefix}".`,
          },
          blockPublicAccess: {
            type: "boolean",
            description: "Block all public access on the bucket. Defaults to true.",
          },
          enableEncryption: {
            type: "boolean",
            description: "Enable default AES256 server-side encryption. Defaults to true.",
          },
        },
      },
    },
  };

  return {
    listS3Buckets,
    createS3Bucket,
    listS3BucketsTool,
    createS3BucketTool,
  };
}