---
type: Fixed
pr: 856
---
Moved profile-pipeline extraction/sample temp directories under the dedicated GSD temp root so stale reaping can find them, and added cleanup for tests that created `gsd-*` temp directories without teardown.
