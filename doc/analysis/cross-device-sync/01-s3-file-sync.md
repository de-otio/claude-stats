# Option 1: S3 File-Based Sync (Simplest)

**How it works:** Each device exports its data as JSON to a per-user S3 bucket. On sync, devices download and merge. Optionally add CloudFront for faster global reads.

## Implementation sketch

1. User authenticates via Cognito Identity Pool (or static credentials for single-user)
2. On `collect`, export new sessions as JSONL to `s3://<bucket>/<user-id>/sessions/`
3. On sync, download remote sessions not in local DB, upsert into SQLite
4. Use S3 object versioning or ETags for basic conflict avoidance

## Pros

- Minimal infrastructure (S3 bucket + IAM policy)
- Extremely cheap ($0.023/GB storage, $0.0004/1K GETs)
- Simple mental model: files in, files out
- Works well for single-user, multi-device (no real conflicts)

## Cons

- No real-time sync (poll-based or manual trigger)
- No built-in conflict resolution
- You build the merge logic yourself
- No offline queue framework

## Cost

Near-zero for typical usage (free tier: 5 GB S3, 20K GETs/month).

## Complexity

Low. ~200-400 lines of sync code.

## Best for

MVP / single-user sync where simplicity matters most.
