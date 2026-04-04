import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
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

interface ValidationError {
  file: string;
  errors: string[];
}

interface FileValidationResult {
  file: string;
  type: string;
  errors: string[];
}

const validationErrors: ValidationError[] = [];

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
 * Extract namespace from file path
 */
function extractNamespace(filePath: string): string | null {
  const parts = filePath.split("/");
  if (parts.length >= 2) {
    return parts[1];
  }
  return null;
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
  const fullPath = resolve(repoRoot, filePath);
  try {
    const data = parseJsonFile(fullPath);
    return validateMetadata(filePath, data, figSpecMetadataSchema);
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
  const fullPath = resolve(repoRoot, filePath);
  try {
    const data = parseJsonFile(fullPath);
    return validateMetadata(filePath, data, figStackMetadataSchema);
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
  const fullPath = resolve(repoRoot, filePath);
  try {
    const data = parseJsonFile(fullPath);
    return validateMetadata(filePath, data, figParserMetadataSchema);
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

  try {
    const data = parseJsonFile(fullPath);
    const errors = validateMetadata(
      filePath,
      data,
      namespaceMetadataSchema
    );

    // If schema is valid, check that PR author is in editors
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
