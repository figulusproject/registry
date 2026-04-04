## What does this PR add or change?

Please describe the change or addition you're submitting to the registry. Include details about:
- Which specs, stacks, or parsers are being added or modified
- Any namespace-level changes
- Why this addition is valuable to the Figulus community

## Namespace ownership confirmed?

- [ ] I own the namespace or am listed as an editor in its `namespaces/{namespace}.json` file
- [ ] For `figulus/` namespace: I am a member of the `figulusproject` organization

## Have you tested the spec/stack/parser locally with Figulus?

- [ ] I've verified that the spec/stack/parser works correctly with `figulus` CLI
- [ ] All blob files (figspec, figstack, js) are valid and can be executed/parsed

## Checklist

Before submitting, verify the following:

### Metadata Files
- [ ] All metadata JSON files have valid `title` and `author` fields
- [ ] SPDX license IDs are correct (e.g., "MIT", "Apache-2.0", "PostgreSQL")
- [ ] Required fields match the registry schema (`description`, `author`, `license`, `variants`)
- [ ] For multiple authors, they're correctly formatted as objects with `type`, `name`, and optional `url`

### Blob Files
- [ ] Blob filenames match their SHA-256 content hash
  - Run locally: `sha256sum blobs/*/hash.ext` and verify it matches the filename
- [ ] Blob files have the correct extension: `.figspec`, `.figstack`, or `.js`
- [ ] Blobs are referenced in metadata via the correct hash in variant `blob.contentHash`

### File Structure
- [ ] No files are accidentally included outside of `specs/`, `stacks/`, `parsers/`, `blobs/`, or `namespaces/`
- [ ] New namespace directories follow the pattern: `{type}/{namespace}/{id}.json`
- [ ] Blob directories follow the pattern: `blobs/{namespace}/{contentHash}.{ext}`

---

**The GitHub Actions validator will automatically check all of the above. If it fails, review the error message and fix the issues before your PR can be merged.**
