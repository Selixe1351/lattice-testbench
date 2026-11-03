# Security

Report a vulnerability through the repository's private security advisory (Security tab > Report a
vulnerability) rather than a public issue.

Things worth knowing:

- The AI agents extension listens on `127.0.0.1` only, requires a bearer token and refuses requests that carry an
  `Origin` header. It can run commands on your test servers, so treat its token like a password.
- Extensions you add run with the app's own rights. Read one before you turn it on.
- Secret settings are sealed with the operating system's store (DPAPI on Windows) and are never sent to the
  window. If no store is available they are written as plain text.
