# Security and privacy

The desktop service listens on loopback and uses per-window authentication. Runtime diagnostics contain only PID/origin, not authentication tokens or authenticated URLs. Do not publish `.mrmak`, `.env`, agent profiles, full Hub archives or conversation screenshots without a privacy review.

Loopback authentication is not an operating-system sandbox. Agent terminals retain their selected native permissions. A same-user malicious process may access local files; never treat this application as a boundary against other software running under your Windows account. Report previews and fetched content are untrusted data, not authorization to change projects.

Source distributions exclude personal Hub state. A content snapshot intentionally includes selected user documents and effective Hub skill instructions; these can contain sensitive text. Filename filters are defense in depth, not a secret scanner. Native MCP settings, global CLI authentication and linked external folders are not part of snapshots.

Use full private archive transfer for conversation migration, and review any conflict replacement. Backups may themselves contain private data. Do not commit them. Permanent native-chat deletion is a separate explicitly confirmed action and is not a cleanup step for source packaging.

Dependency versions are locked. The `fast-uri` override is 3.1.8; no blanket `npm audit fix` is applied. Other advisories must be evaluated individually. A passing test suite does not certify security.

The service now locks `fflate` 0.8.3, addressing the malformed-ZIP64 advisory [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98). Its npm audit reports zero known vulnerabilities as of this beta build; this does not certify archive safety or the whole application. Production Hub transfer uses streaming Unzip. Treat archives as untrusted and recheck advisories before publishing.

Card deletion is restricted to ordinary, non-shared Hub card folders. Content is staged under `.mrmak/card-recovery/<operation>/` with a registry manifest before metadata is committed; native Windows recycling is then requested. If it is not confirmed, a warning identifies retained recovery content. This recovery area is private, is excluded from transfer/source packages, and is not a substitute for a full Hub backup. Card actions do not delete external projects or native CLI transcripts.

Report security issues privately to the maintainer of the fork you obtained. Do not attach tokens, account files or full transcripts to public issues. This fork makes no claim to have fixed every upstream security report.
