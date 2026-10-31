# Coordinate Azure and TRMNL releases after human landing

Azure and the TRMNL private plugin are separate deployment surfaces with a shared
agenda contract. After the owner's reviewed merge to `main`, release each
affected target automatically, coordinating Azure deployment and verification
before TRMNL when both change; serialize every qualifying commit without
coalescing, and block successors after failure. This moves release authorization
to human review and landing, not to an additional deployment approval, while
keeping PR merges human-only.

The owner accepts breaking-contract outages and destructive reviewed
infrastructure changes only inside `rg-trmnl-calendar`, excluding deletion of
the group and unmanaged resources. Preserve live TRMNL field values and require
deployed-service verification, but not per-release physical-device approval;
recovery is explicit rather than automatic because infrastructure changes may
be irreversible. See the [confirmed CD design](../automated-delivery.md) for the
full boundaries, activation prerequisites, and queue semantics. This records an
accepted design, not an implemented or active deployment system.
