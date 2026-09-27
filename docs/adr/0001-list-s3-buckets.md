# ADR-0001: List Current S3 Buckets

## Status
Accepted

## Context
As part of the infrastructure documentation and planning process, it is important to understand the current state of AWS S3 buckets available in the account. This decision records the initial inventory of S3 buckets present in the environment.

## Decision
We will document the current list of S3 buckets in the `docs/adr/0001-list-s3-buckets.md` file as part of our Architecture Decision Records (ADR) system. This provides a baseline for future infrastructure decisions and helps maintain visibility into existing resources.

## Consequences
- Provides an audit trail of existing S3 resources
- Helps prevent accidental duplication or conflicts in new resource creation
- Establishes a precedent for documenting infrastructure inventory in ADRs
- Creates a reference point for future decisions regarding storage strategies

## Bucket Inventory
The following S3 buckets were found in the account:

1. `33north.co` - Created on 2026-04-27
2. `ato-buildserver-tf-backend-state` - Created on 2026-05-01
3. `ato-cf-logging-bucket-aborttoorbit.com` - Created on 2026-04-30
4. `ato-tf-backend-state` - Created on 2026-04-30
5. `ato-web-bucket-aborttoorbit.com` - Created on 2026-05-01
6. `images1misc` - Created on 2026-04-29
7. `ms-simple-api-implicitly-roughly-clear-dane` - Created on 2026-04-29
8. `terraform-backend-65072-122022` - Created on 2026-04-28

This inventory will be used as a reference point for any future infrastructure decisions and modifications.