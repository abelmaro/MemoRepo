# Security Policy

## Supported Versions

Security fixes are provided for the latest release. Older releases are not
supported; confirm an issue against the latest version before reporting it
when practical.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Reporting a Vulnerability

Do not open a public issue, discussion, or pull request for a suspected
vulnerability.

Use GitHub's private vulnerability reporting flow:

[Report a vulnerability privately](https://github.com/abelmaro/MemoRepo/security/advisories/new)

Include enough information to investigate safely:

- The affected version or commit
- The affected component and deployment mode
- A description of the impact and realistic attack scenario
- Minimal reproduction steps or a proof of concept
- Any known prerequisites, mitigations, or workarounds
- Whether the issue has been disclosed elsewhere

Remove credentials, personal data, private repository content, and unrelated
local information from all reports and attachments.

You should receive an acknowledgement within five business days. The
maintainer will then confirm whether the report is accepted, request any
missing details, and provide updates when the assessment or remediation status
changes. Resolution time depends on severity and complexity.

Please allow time for a fix and coordinated release before publishing details.
If the report is declined, the response will explain why when it is safe to do
so.

## Security Scope

Reports are especially useful when they involve credential exposure, unsafe
network access, authorization boundaries, path handling, command execution,
data isolation, log redaction, or unintended disclosure of repository data.

The documented local-only deployment assumptions remain part of the security
model. Unsupported public or multi-user deployments may still reveal a defect,
but reports should distinguish a product vulnerability from risks caused only
by operating outside those assumptions.
