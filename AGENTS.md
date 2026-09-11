# GuideX Runtime v4 Schema Lifecycle

- Current status: NOT FINALIZED. Only explicit user confirmation finalizes the fields.
- During v4 schema iteration, clear obsolete test results and aggregates only for
  `ext_guidex-runtime-v4` in the verified environment. Check target and counts
  before clearing, then verify that unrelated records and registrations remain.
- Do not maintain temporary v4 aliases or reconstruct missing milestones.
  Legacy adapter support is separate and must remain intact.
- Never add scheduled, startup, plugin-load, or per-result automatic deletion.
- After user sign-off, mark this status, `docs/guidex-runtime-v4.md` and the sibling
  ProbeX repository's status FINALIZED. Preserve historical results during future
  field changes; use versioning, migration or compatibility instead.
  Existing retention policies are separate.
- Read `docs/guidex-runtime-v4.md` before changing fields. Reload the extension
  and GuideX page before collecting new samples; clearing remote data alone
  does not update already-injected pages or discard pending client reports.
