import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
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
  npm: new Set(["test", "run", "install", "ci", "ls", "list", "outdated", "audit", "build"]),
  git: new Set(["status", "diff", "log", "show", "branch"]),
};

// "npm run dev" starts this very agent, which would call an LLM that could call
// "npm run dev" again -- an unbounded, resource-consuming recursive spawn.
const BLOCKED_NPM_RUN_SCRIPTS = new Set(["dev"]);

// Blocks shell metacharacters/injection attempts even though execFile never
// spawns a shell; this keeps arguments limited to plausible CLI tokens.
const SAFE_ARG = /^[A-Za-z0-9_.:@/=-]+$/;

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
  async function listFiles(dirPath: string): Promise<string[]> {
    const safePath = resolveSafePath(rootDir, dirPath);
    return await readdir(safePath);
  }

  async function readTextFile(filePath: string): Promise<string> {
    const safePath = resolveSafePath(rootDir, filePath);
    assertNotSecretFile(safePath);
    return await readFile(safePath, "utf8");
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
        `Running "npm run ${args[1]}" is blocked because it would recursively launch this agent itself.`
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
        "List the files and directories in a given directory, relative to the project root.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "The directory path to list, relative to the project root.",
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

  const runCommandTool = {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run an allow-listed command inside the project root to build, test, or inspect the project. " +
        "Only 'npm' (test/run/install/ci/ls/list/outdated/audit/build) and 'git' (status/diff/log/show/branch) " +
        "are permitted. Cannot run arbitrary shell commands or mutate git history.",
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
    runCommand,
    listFilesTool,
    readFileTool,
    writeFileTool,
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