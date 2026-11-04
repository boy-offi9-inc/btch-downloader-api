# Security Policy

## Supported versions

Only the latest release on `main` receives fixes.

| Version | Supported |
| ------- | --------- |
| 1.3.x   | ✅        |
| < 1.3   | ❌        |

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Use GitHub's private
reporting instead: **Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and the version/commit. You can expect
an acknowledgement within a few days and a fix or a clear answer after that. If the
report is accepted you'll be credited in the release notes (unless you'd rather not
be); if it's declined you'll get the reason.

## Scope notes

- `/api/fetch-media` streams third-party files through this server. It refuses
  private/internal addresses (checked at connect time and on every redirect), but
  on a public deployment you should also set `FETCH_MEDIA_ALLOWED_HOSTS` and keep
  the rate limits on.
- This project wraps the `btch-downloader` library and inherits its upstream
  providers; issues in those providers should be reported to that project.
