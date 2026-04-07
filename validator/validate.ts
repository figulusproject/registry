import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import stripComments from "strip-json-comments";
import {
  namespaceMetadataSchema,
  namespaceVerificationsSchema,
  pushLimitOverridesSchema,
  figSpecMetadataSchema,
  figStackMetadataSchema,
  figParserMetadataSchema,
} from "@figulus/registry-schema";
import { z } from "zod";

interface FileValidationResult {
  file: string;
  type: string;
  errors: string[];
}

/**
 * Registry maintainers who can modify governance files and reserved namespaces
 */
const REGISTRY_MAINTAINERS = ["figulusproject"];

/**
 * Namespaces that cannot be claimed by regular users
 */
const RESTRICTED_NAMESPACES = ["verified", "push-limit-overrides", "official"];

/**
 * Parse command line arguments
 */
function parseArgs(): {
  changedFiles: string[];
} {
  const args = process.argv.slice(2);
  let changedFiles: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--changed-files" && i + 1 < args.length) {
      const fileList = args[i + 1];
      changedFiles = fileList.split(/\s+/).filter((f) => f.length > 0);
      i++;
    }
  }

  return { changedFiles };
}

/**
 * Get repository root from environment or use current directory
 */
function getRepoRoot(): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace) return workspace;

  // For local testing, use current directory
  return process.cwd();
}

/**
 * Determine file type from path
 */
function getFileType(
  filePath: string
): "spec" | "stack" | "parser" | "blob" | "namespace" | "verified" | "limits" | null {
  if (filePath.startsWith("specs/")) return "spec";
  if (filePath.startsWith("stacks/")) return "stack";
  if (filePath.startsWith("parsers/")) return "parser";
  if (filePath.startsWith("blobs/")) return "blob";
  if (filePath.startsWith("namespaces/") && filePath.endsWith(".json")) {
    if (filePath === "namespaces/verified.json") return "verified";
    if (filePath === "namespaces/push-limit-overrides.json") return "limits";
    return "namespace";
  }
  return null;
}

/**
 * Compute SHA-256 hash of file content
 */
function computeFileHash(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    throw new Error(`Failed to read file: ${filePath}`);
  }
}

/**
 * Parse JSON with comment stripping
 */
function parseJsonFile(filePath: string): any {
  try {
    const content = readFileSync(filePath, "utf-8");
    const cleanedContent = stripComments(content);
    return JSON.parse(cleanedContent);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Validate blob references in spec/stack/parser metadata
 */
function validateBlobReferences(
  filePath: string,
  data: any,
  repoRoot: string,
  extension: "figspec" | "figstack" | "js"
): string[] {
  const errors: string[] = [];

  // Extract namespace from file path (e.g., "specs/myns/myspec.json" -> "myns")
  const parts = filePath.split("/");
  if (parts.length < 2) {
    return errors; // Invalid path, will be caught elsewhere
  }
  const namespace = parts[1];

  // Check variants array
  const variants = data.variants || [];
  if (!Array.isArray(variants)) {
    return errors; // Not an array, will be caught by schema validation
  }

  for (const variant of variants) {
    const blob = variant.blob || {};
    const contentHash = blob.contentHash;

    if (!contentHash) {
      continue; // Will be caught by schema validation
    }

    const blobPath = `blobs/${namespace}/${contentHash}.${extension}`;
    const fullBlobPath = resolve(repoRoot, blobPath);

    // Check if blob file exists
    if (!existsSync(fullBlobPath)) {
      errors.push(
        `Variant references blob ${contentHash} but blobs/${namespace}/${contentHash}.${extension} does not exist in the repository`
      );
    }
  }

  return errors;
}

/**
 * Get namespace metadata from HEAD
 */
function getNamespaceMetadataFromHead(
  namespace: string,
  repoRoot: string
): {
  owner: { githubUsername: string };
  editors: { githubUsername: string; pushLimit?: { unit: "daily" | "weekly"; value: number } }[];
} | null {
  try {
    const filePath = `namespaces/${namespace}.json`;
    const headContent = execSync(`git show HEAD:${filePath}`, {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    const data = JSON.parse(stripComments(headContent));
    const result = namespaceMetadataSchema.safeParse(data);
    return result.success ? data : null;
  } catch (error) {
    // Namespace doesn't exist in HEAD or git failed
    return null;
  }
}

/**
 * Get push limit overrides from HEAD
 */
function getPushLimitOverrides(
  repoRoot: string
): { namespace: string; pushLimit: { unit: "daily" | "weekly"; value: number } }[] {
  try {
    const filePath = "namespaces/push-limit-overrides.json";
    const headContent = execSync(`git show HEAD:${filePath}`, {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    const data = JSON.parse(stripComments(headContent));
    const result = pushLimitOverridesSchema.safeParse(data);
    return result.success ? data : [];
  } catch (error) {
    // File doesn't exist or git failed
    return [];
  }
}

/**
 * Check if author has exceeded their push limit for a namespace
 */
function checkPushLimit(
  prAuthor: string,
  namespace: string,
  repoRoot: string
): string | null {
  // Get namespace metadata
  const namespaceMetadata = getNamespaceMetadataFromHead(namespace, repoRoot);
  if (namespaceMetadata === null) {
    // New namespace - no limit applicable yet
    return null;
  }

  // Find editor entry for this author
  const editorEntry = namespaceMetadata.editors.find(
    (e) => e.githubUsername === prAuthor
  );
  if (!editorEntry) {
    // Permission check in validateSpec/validateStack/validateParser will catch this
    return null;
  }

  // Get per-editor push limit
  let editorLimit = editorEntry.pushLimit || { unit: "daily" as const, value: 10 };

  // Check for overrides
  const overrides = getPushLimitOverrides(repoRoot);
  const override = overrides.find((o) => o.namespace === namespace);

  // Use Math.min if override exists
  let effectiveLimit = editorLimit;
  let limitSource = "editor settings";

  if (override) {
    const overrideValue = override.pushLimit.value;
    const editorValue = editorLimit.value;

    if (overrideValue < editorValue) {
      effectiveLimit = override.pushLimit;
      limitSource = "namespace override";
    }
  } else {
    // No override - check if we should use default
    if (!editorEntry.pushLimit) {
      limitSource = "default (10/day)";
    }
  }

  // Query GitHub API to count recent PRs
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    // Can't check without token - skip validation
    return null;
  }

  try {
    // Calculate time window
    const now = new Date();
    let startDate: Date;

    if (effectiveLimit.unit === "daily") {
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Build file path patterns for the namespace
    const filePrefixes = [
      `specs/${namespace}/`,
      `stacks/${namespace}/`,
      `parsers/${namespace}/`,
      `blobs/${namespace}/`,
    ];

    // Query GitHub API
    const response = execSync(
      `curl -s -H "Authorization: Bearer ${githubToken}" "https://api.github.com/repos/figulusproject/registry/pulls?state=all&per_page=100"`,
      { encoding: "utf-8" }
    );

    const prs = JSON.parse(response);

    // Filter PRs by author, creation date, and affected files
    let count = 0;
    for (const pr of prs) {
      if (pr.user.login !== prAuthor) continue;

      const createdAt = new Date(pr.created_at);
      if (createdAt < startDate) continue;

      // Check if this PR touches any files in our namespace
      // Get PR files using the GitHub API
      const filesResponse = execSync(
        `curl -s -H "Authorization: Bearer ${githubToken}" "${pr.url}/files?per_page=100"`,
        { encoding: "utf-8" }
      );

      const files = JSON.parse(filesResponse);
      const touchesNamespace = files.some((f: any) =>
        filePrefixes.some((prefix) => f.filename.startsWith(prefix))
      );

      if (touchesNamespace) {
        count++;
      }
    }

    // Check if limit exceeded
    if (count >= effectiveLimit.value) {
      return `Push limit exceeded for namespace "${namespace}": ${count}/${effectiveLimit.value} ${effectiveLimit.unit} pushes used. Limit set by ${limitSource}.`;
    }

    return null;
  } catch (error) {
    // If GitHub API call fails, skip validation to not block PRs
    return null;
  }
}

/**
 * Validate a metadata file with Zod schema
 */
function validateMetadata(
  filePath: string,
  data: any,
  schema: z.ZodType<any>
): string[] {
  const result = schema.safeParse(data);
  if (!result.success) {
    return result.error.issues.map((err) => {
      const path = err.path.length > 0 ? err.path.join(".") : "root";
      return `${path}: ${err.message}`;
    });
  }
  return [];
}

/**
 * Validate a blob file
 */
function validateBlob(
  filePath: string,
  repoRoot: string
): string[] {
  const errors: string[] = [];

  // Extract expected hash from filename
  const fileName = filePath.split("/").pop();
  if (!fileName) {
    errors.push("Invalid blob filename");
    return errors;
  }

  // Split filename and extension (e.g., "abc123.figspec" -> ["abc123", "figspec"])
  const parts = fileName.split(".");
  if (parts.length < 2) {
    errors.push("Blob filename must have extension");
    return errors;
  }

  const expectedHash = parts[0];
  const extension = parts.slice(1).join(".");

  // Validate extension
  if (!["js", "figspec", "figstack"].includes(extension)) {
    errors.push(
      `Invalid blob extension: ${extension} (must be js, figspec, or figstack)`
    );
    return errors;
  }

  // Compute actual hash
  const fullPath = resolve(repoRoot, filePath);
  try {
    const actualHash = computeFileHash(fullPath);
    if (actualHash !== expectedHash) {
      errors.push(
        `Hash mismatch: filename hash ${expectedHash} does not match content hash ${actualHash}`
      );
    }
  } catch (error) {
    errors.push(
      `Failed to verify blob: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return errors;
}

/**
 * Validate a spec metadata file
 */
function validateSpec(filePath: string, repoRoot: string): string[] {
  const prAuthor = process.env.GITHUB_ACTOR || "";

  // Check if trying to modify figulus/ namespace
  if (filePath.startsWith("specs/figulus/")) {
    if (!REGISTRY_MAINTAINERS.includes(prAuthor)) {
      return [
        "The figulus/ namespace is reserved for the official Figulus project. Changes require maintainer approval.",
      ];
    }
  } else {
    // For non-figulus namespaces, check that PR author is a listed editor
    const parts = filePath.split("/");
    if (parts.length >= 2) {
      const namespace = parts[1];
      const namespaceMetadata = getNamespaceMetadataFromHead(namespace, repoRoot);
      if (namespaceMetadata === null) {
        return [
          `Namespace "${namespace}" does not exist. Run \`figulus registry claim ${namespace}\` to claim it before publishing.`,
        ];
      }
      const isEditor = namespaceMetadata.editors.some(
        (e) => e.githubUsername === prAuthor
      );
      if (!isEditor) {
        return [
          `PR author "${prAuthor}" is not listed as an editor for namespace "${namespace}"`,
        ];
      }

      // Check push limits
      const pushLimitError = checkPushLimit(prAuthor, namespace, repoRoot);
      if (pushLimitError) {
        return [pushLimitError];
      }
    }
  }

  const fullPath = resolve(repoRoot, filePath);
  try {
    const data = parseJsonFile(fullPath);
    const errors = validateMetadata(filePath, data, figSpecMetadataSchema);
    if (errors.length > 0) {
      return errors;
    }

    // Validate blob references
    const blobErrors = validateBlobReferences(filePath, data, repoRoot, "figspec");
    return blobErrors;
  } catch (error) {
    return [
      `Failed to parse spec: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/**
 * Validate a stack metadata file
 */
function validateStack(filePath: string, repoRoot: string): string[] {
  const prAuthor = process.env.GITHUB_ACTOR || "";

  // Check if trying to modify figulus/ namespace
  if (filePath.startsWith("stacks/figulus/")) {
    if (!REGISTRY_MAINTAINERS.includes(prAuthor)) {
      return [
        "The figulus/ namespace is reserved for the official Figulus project. Changes require maintainer approval.",
      ];
    }
  } else {
    // For non-figulus namespaces, check that PR author is a listed editor
    const parts = filePath.split("/");
    if (parts.length >= 2) {
      const namespace = parts[1];
      const namespaceMetadata = getNamespaceMetadataFromHead(namespace, repoRoot);
      if (namespaceMetadata === null) {
        return [
          `Namespace "${namespace}" does not exist. Run \`figulus registry claim ${namespace}\` to claim it before publishing.`,
        ];
      }
      const isEditor = namespaceMetadata.editors.some(
        (e) => e.githubUsername === prAuthor
      );
      if (!isEditor) {
        return [
          `PR author "${prAuthor}" is not listed as an editor for namespace "${namespace}"`,
        ];
      }

      // Check push limits
      const pushLimitError = checkPushLimit(prAuthor, namespace, repoRoot);
      if (pushLimitError) {
        return [pushLimitError];
      }
    }
  }

  const fullPath = resolve(repoRoot, filePath);
  try {
    const data = parseJsonFile(fullPath);
    const errors = validateMetadata(filePath, data, figStackMetadataSchema);
    if (errors.length > 0) {
      return errors;
    }

    // Validate blob references
    const blobErrors = validateBlobReferences(filePath, data, repoRoot, "figstack");
    return blobErrors;
  } catch (error) {
    return [
      `Failed to parse stack: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/**
 * Validate a parser metadata file
 */
function validateParser(filePath: string, repoRoot: string): string[] {
  const prAuthor = process.env.GITHUB_ACTOR || "";

  // Check if trying to modify figulus/ namespace
  if (filePath.startsWith("parsers/figulus/")) {
    if (!REGISTRY_MAINTAINERS.includes(prAuthor)) {
      return [
        "The figulus/ namespace is reserved for the official Figulus project. Changes require maintainer approval.",
      ];
    }
  } else {
    // For non-figulus namespaces, check that PR author is a listed editor
    const parts = filePath.split("/");
    if (parts.length >= 2) {
      const namespace = parts[1];
      const namespaceMetadata = getNamespaceMetadataFromHead(namespace, repoRoot);
      if (namespaceMetadata === null) {
        return [
          `Namespace "${namespace}" does not exist. Run \`figulus registry claim ${namespace}\` to claim it before publishing.`,
        ];
      }
      const isEditor = namespaceMetadata.editors.some(
        (e) => e.githubUsername === prAuthor
      );
      if (!isEditor) {
        return [
          `PR author "${prAuthor}" is not listed as an editor for namespace "${namespace}"`,
        ];
      }

      // Check push limits
      const pushLimitError = checkPushLimit(prAuthor, namespace, repoRoot);
      if (pushLimitError) {
        return [pushLimitError];
      }
    }
  }

  const fullPath = resolve(repoRoot, filePath);
  try {
    const data = parseJsonFile(fullPath);
    const errors = validateMetadata(filePath, data, figParserMetadataSchema);
    if (errors.length > 0) {
      return errors;
    }

    // Validate blob references
    const blobErrors = validateBlobReferences(filePath, data, repoRoot, "js");
    return blobErrors;
  } catch (error) {
    return [
      `Failed to parse parser: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/**
 * Validate a namespace metadata file
 */
function validateNamespaceMetadata(
  filePath: string,
  repoRoot: string
): string[] {
  const fullPath = resolve(repoRoot, filePath);
  const prAuthor = process.env.GITHUB_ACTOR || "";

  // Extract namespace name from path (e.g., "namespaces/myns.json" -> "myns")
  const namespaceName = filePath.split("/")[1]?.replace(".json", "");

  // Check if namespace name is restricted
  if (namespaceName && RESTRICTED_NAMESPACES.includes(namespaceName)) {
    return [
      `Cannot create namespace "${namespaceName}": this name is reserved for the Figulus project`,
    ];
  }

  // Check if trying to modify figulus namespace
  if (namespaceName === "figulus") {
    if (!REGISTRY_MAINTAINERS.includes(prAuthor)) {
      return [
        "The figulus/ namespace is reserved for the official Figulus project. Changes require maintainer approval.",
      ];
    }
  }

  // Check if namespace already exists in HEAD
  let headData: any = null;
  if (namespaceName) {
    try {
      const headContent = execSync(`git show HEAD:${filePath}`, {
        cwd: repoRoot,
        encoding: "utf-8",
      });
      // Namespace exists in HEAD - validate against HEAD version to prevent squatting
      try {
        headData = JSON.parse(stripComments(headContent));
        const headEditors = headData.editors || [];
        const isEditorInHead = headEditors.some(
          (e: any) => e.githubUsername === prAuthor
        );
        if (!isEditorInHead) {
          return [
            `PR author "${prAuthor}" is not listed as an editor in the existing namespace metadata`,
          ];
        }

        // Check that non-owners cannot change the owner field
        try {
          const submittedData = parseJsonFile(fullPath);
          const headOwner = headData.owner?.githubUsername;
          const submittedOwner = submittedData.owner?.githubUsername;

          if (
            submittedOwner !== headOwner &&
            prAuthor !== headOwner
          ) {
            return [
              `Only the namespace owner ("${headOwner}") can transfer ownership`,
            ];
          }
        } catch (parseError) {
          // Continue - this error will be caught again during full validation
        }

        // Namespace exists in HEAD and author is a valid editor with no ownership violations
        // Validate the submitted file against the schema
        try {
          const data = parseJsonFile(fullPath);
          const errors = validateMetadata(
            filePath,
            data,
            namespaceMetadataSchema
          );
          return errors;
        } catch (error) {
          return [
            `Failed to parse namespace metadata: ${error instanceof Error ? error.message : String(error)}`,
          ];
        }
      } catch (parseError) {
        return [
          `Failed to parse HEAD version of namespace metadata: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        ];
      }
    } catch (gitError) {
      // File doesn't exist in HEAD - this is a new namespace claim
      // Fall through to validate the new submission
    }
  }

  // If we reach here, the namespace doesn't exist in HEAD (new namespace claim)
  try {
    const data = parseJsonFile(fullPath);
    const errors = validateMetadata(
      filePath,
      data,
      namespaceMetadataSchema
    );

    // For new namespaces, check that PR author is in editors
    if (errors.length === 0 && prAuthor) {
      const editors = data.editors || [];
      const isEditor = editors.some(
        (e: any) => e.githubUsername === prAuthor
      );
      if (!isEditor) {
        errors.push(
          `PR author "${prAuthor}" is not listed as an editor in the namespace`
        );
      }
    }

    return errors;
  } catch (error) {
    return [
      `Failed to parse namespace metadata: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/**
 * Validate verified namespaces file
 */
function validateVerified(filePath: string, repoRoot: string): string[] {
  const prAuthor = process.env.GITHUB_ACTOR || "";

  // Only maintainers can modify verified.json
  if (!REGISTRY_MAINTAINERS.includes(prAuthor)) {
    return [
      "Only repository maintainers can modify namespaces/verified.json",
    ];
  }

  const fullPath = resolve(repoRoot, filePath);
  try {
    const data = parseJsonFile(fullPath);
    return validateMetadata(filePath, data, namespaceVerificationsSchema);
  } catch (error) {
    return [
      `Failed to parse verified namespaces: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/**
 * Validate push limit overrides file
 */
function validateLimits(filePath: string, repoRoot: string): string[] {
  const prAuthor = process.env.GITHUB_ACTOR || "";

  // Only maintainers can modify push-limit-overrides.json
  if (!REGISTRY_MAINTAINERS.includes(prAuthor)) {
    return [
      "Only repository maintainers can modify namespaces/push-limit-overrides.json",
    ];
  }

  const fullPath = resolve(repoRoot, filePath);
  try {
    const data = parseJsonFile(fullPath);
    return validateMetadata(filePath, data, pushLimitOverridesSchema);
  } catch (error) {
    return [
      `Failed to parse push limit overrides: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/**
 * Validate a single file
 */
function validateFile(
  filePath: string,
  repoRoot: string
): FileValidationResult {
  const fileType = getFileType(filePath);

  if (!fileType) {
    return {
      file: filePath,
      type: "unknown",
      errors: ["File path does not match any known registry structure"],
    };
  }

  let errors: string[] = [];

  switch (fileType) {
    case "spec":
      errors = validateSpec(filePath, repoRoot);
      break;
    case "stack":
      errors = validateStack(filePath, repoRoot);
      break;
    case "parser":
      errors = validateParser(filePath, repoRoot);
      break;
    case "blob":
      errors = validateBlob(filePath, repoRoot);
      break;
    case "namespace":
      errors = validateNamespaceMetadata(filePath, repoRoot);
      break;
    case "verified":
      errors = validateVerified(filePath, repoRoot);
      break;
    case "limits":
      errors = validateLimits(filePath, repoRoot);
      break;
  }

  return { file: filePath, type: fileType, errors };
}

/**
 * Main validation function
 */
function main(): void {
  const { changedFiles } = parseArgs();
  const repoRoot = getRepoRoot();

  if (changedFiles.length === 0) {
    console.log("No changed files to validate");
    process.exit(0);
  }

  const results: FileValidationResult[] = [];
  let hasErrors = false;

  for (const file of changedFiles) {
    const result = validateFile(file, repoRoot);
    results.push(result);

    if (result.errors.length > 0) {
      hasErrors = true;
    }
  }

  // Output results
  if (hasErrors) {
    console.error("\n❌ Validation failed:\n");
    for (const result of results) {
      if (result.errors.length > 0) {
        console.error(`📄 ${result.file}:`);
        result.errors.forEach((err) => {
          console.error(`   • ${err}`);
        });
      }
    }
    process.exit(1);
  } else {
    console.log("✅ All validations passed!");
    process.exit(0);
  }
}

main();
