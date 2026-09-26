# Security Policy

Forge handles source code, credentials in the developer environment, filesystem writes, and development commands. Please do not disclose a suspected vulnerability in a public issue.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting or Security Advisory feature for this repository when available. Include steps to reproduce, affected versions or commits, impact, and any relevant platform details. Do not include live credentials or private user data. If private reporting is unavailable, contact a repository maintainer through a private channel before sharing details publicly.

## Scope and Expectations

Security reports are especially useful for workspace-boundary bypasses, sensitive-file disclosure, command-policy bypasses, unsafe patch application, approval-state confusion, and accidental inclusion of unrelated Git changes. The model is not an authority: tools must validate requests and enforce policy and approval independently.

Forge does not provide an operating-system sandbox. Users should review project scripts and commands before approving them. Do not treat this early-stage foundation as a substitute for normal endpoint, credential, or repository protections.