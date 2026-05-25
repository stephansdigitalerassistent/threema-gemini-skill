# Dependency Audit Report

This report summarizes the security audit (`npm audit`) and outdated package analysis (`npm outdated`) for the **threema-gemini-skill** project and its local dependency **threema-openclaw**.

---

## Executive Summary

- **threema-gemini-skill (Root Project):**
  - **Vulnerabilities:** 0 vulnerabilities detected.
  - **Outdated Packages:** 0 outdated packages. All direct and devDependencies are at their latest versions.
- **threema-openclaw (Local Dependency):**
  - **Vulnerabilities:** 3 vulnerabilities found (1 Critical, 2 Moderate) affecting `protobufjs` and `ws`.
  - **Outdated Packages:** 7 direct packages are outdated, including the `@noble` cryptographic libraries.

---

## Direct Dependency Status Matrix

The table below shows the current version alignment for the key cryptographic libraries, the local `threema-openclaw` module, and other relevant packages.

| Package Name | Root Project Constraint | Root Installed Version | OpenClaw Constraint | OpenClaw Installed Version | Latest Version | Status / Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`@noble/ciphers`** | `^2.2.0` | `2.2.0` | `^2.1.1` | `2.1.1` | `2.2.0` | Outdated in OpenClaw |
| **`@noble/curves`** | `^2.2.0` | `2.2.0` | `^2.0.1` | `2.0.1` | `2.2.0` | Outdated in OpenClaw |
| **`@noble/hashes`** | `^2.2.0` | `2.2.0` | `^2.0.1` | `2.0.1` | `2.2.0` | Outdated in OpenClaw |
| **`tweetnacl`** | `^1.0.3` | `1.0.3` | *N/A* | *N/A* | `1.0.3` | Up to date |
| **`threema-openclaw`**| `file:../threema-new/threema-openclaw` | `0.1.2` | *N/A* | *N/A* | *N/A* | Local directory path |
| **`protobufjs`** | `^8.0.3` | `8.4.2` | `^7.5.4` | `7.5.4` | `8.4.2` | Vulnerable & Outdated in OpenClaw |
| **`ws`** | `^8.20.0` | `8.21.0` | `^8.19.0` | `8.19.0` | `8.21.0` | Vulnerable & Outdated in OpenClaw |

---

## Vulnerability Details (threema-openclaw)

The following vulnerabilities were found in the dependency tree of `/home/ubuntu/threema-new/threema-openclaw`:

### 1. `protobufjs` (Critical Severity)
- **Affected Versions:** `<=7.5.7` (Installed: `7.5.4`)
- **Vulnerability Types:** 
  - Arbitrary code execution (GHSA-xq3m-2v4x-88gg)
  - Code injection through bytes field defaults (GHSA-66ff-xgx4-vchm)
  - Denial of service from crafted field names (GHSA-2pr8-phx7-x9h3)
  - Prototype injection in generated constructors (GHSA-fx83-v9x8-x52w)
  - Unbounded protobuf recursion (GHSA-685m-2w69-288q)
  - Prototype pollution code generation gadget (GHSA-75px-5xx7-5xc7)
  - Denial of Service via JSON descriptor expansion (GHSA-jggg-4jg4-v7c6)
- **Impact:** High risk of arbitrary code execution or Denial of Service (DoS) if parsing untrusted protobuf messages.

### 2. `@protobufjs/utf8` (Moderate Severity)
- **Affected Versions:** `<=1.1.0` (Installed via `protobufjs@7.5.4`)
- **Vulnerability Types:** Overlong UTF-8 decoding (GHSA-q6x5-8v7m-xcrf)
- **Impact:** Can bypass security input validation checks expecting valid UTF-8 sequences.

### 3. `ws` (Moderate Severity)
- **Affected Versions:** `8.0.0 - 8.20.0` (Installed: `8.19.0`)
- **Vulnerability Types:** Uninitialized memory disclosure (GHSA-58qx-3vcg-4xpx)
- **Impact:** A remote attacker could potentially read uninitialized memory blocks, leaking sensitive data.

---

## Recommendations for Safe Upgrades

Since the root project dependencies are fully up to date and secure, all remediation actions should target the local `threema-openclaw` repository at `/home/ubuntu/threema-new/threema-openclaw`.

### 1. Upgrade Noble Cryptographic Libraries (Minor Upgrades)
- **Recommendation:** Bump `@noble/ciphers`, `@noble/curves`, and `@noble/hashes` to `^2.2.0` in `threema-openclaw/package.json`.
- **Rationale:** These are safe minor-version upgrades with no breaking API changes, aligning the local package with the versions already used and tested in the root project.

### 2. Fix Critical `protobufjs` Vulnerability (Patch / Minor Upgrade)
- **Recommendation:** Upgrade `protobufjs` to `^7.5.8` or `^7.6.1` (which resolves the vulnerability while keeping the `7.x` major version).
- **Alternative:** Upgrade to `^8.4.2` to match the root project's major version, provided that integration tests pass.

### 3. Fix Moderate `ws` Vulnerability (Minor/Patch Upgrade)
- **Recommendation:** Upgrade `ws` to `^8.21.0` in `threema-openclaw/package.json`.
- **Rationale:** Version `8.21.0` is a safe minor bump that patches the uninitialized memory disclosure issue.

---

## Verification and Testing
All updates should be validated by running the integration and cryptographic test suites:
1. Within the root repository: `/home/ubuntu/threema-antigravity-skill/.burn/validate.sh`
2. Within the OpenClaw repository: `npm run test:integration`
