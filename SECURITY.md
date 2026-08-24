# Security Policy

## Supported versions

The latest published minor release receives security fixes.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/Atomics-hub/mcp-compat/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include the affected version, impact, reproduction, and any suggested mitigation. You should receive an acknowledgement within three business days.

## Probe safety

The CLI accepts an HTTP or HTTPS endpoint for explicit local use. Products embedding `probeMcpEndpoint` must apply their own outbound network policy before accepting untrusted URLs. In particular, prevent access to loopback, link-local, private, metadata-service, and otherwise privileged network destinations as appropriate for the deployment.

The probe rejects redirects, embedded URL credentials, oversized responses, and unsupported schemes. It does not send authorization credentials or invoke tools.
