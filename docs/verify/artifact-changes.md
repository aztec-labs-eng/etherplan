# Rebuilt artifacts

Part of [Verify contracts](index.md).

Etherplan tracks two kinds of identity: the deployment's address, initcode hash, constructor inputs, and [generation](../project/salts.md#generations); and the artifact's build and source hashes. A rebuild can change artifact provenance without changing deployed bytecode.

## CREATE2 deployments

A plan can reuse an existing CREATE2 deployment after a rebuild when all of these hold:

- The address, initcode, constructor inputs, and salt match recorded state.
- The live code hash equals the saved code hash.
- The new artifact verifies the live contract.

The plan reports the old and new hashes in `observation.stateComparison.artifactDrift` and pins the new artifact hash. Apply sends no transaction for this drift. Under its lock, it rechecks the state record and live code; a change stops with `stale-state` or `drift`. It then records the new artifact and appends the previous artifact, source, proof, and code hashes to `artifactRevisions`. Transaction and deployment provenance stay attached to the existing deployment.

A [pinned-runtime](../recovery/stateful-constructors.md) deployment is reused the same way. Its pre-sign commitment binds the initcode, inputs, address, salt, factory, and runtime pins, but not the artifact hash, so a rebuild with unchanged bytecode keeps the proof valid. A commitment signed by v0.1.2-beta or earlier includes the artifact hash; after such a rebuild, its contract is `unverified`.

If verification fails, the plan marks the contract `conflict` and puts the reasons in `artifactDrift.reasons`. A change to both address and initcode or inputs is a replacement and starts a new revision list. Changing only one is a conflict. A salt change with unchanged initcode, inputs, and generation is also a conflict; `observation.stateComparison.saltChange` explains it, including a rotated mixer or new `derive` label. To deliberately deploy the same contract at a new address, raise its [generation](../project/salts.md#generations).

## Adopted contracts

A contract that the spec adopts by `address` is reused the same way after a rebuild, when the address and constructor inputs match recorded state, the live code hash equals the saved code hash, and the new artifact verifies the live contract. Each plan verifies an adopted contract again, so no import proof is involved. Apply records the new artifact and appends the previous one to `artifactRevisions`; the record stays `observed`. This applies to a record that plan and apply observed; a record without provenance is treated as an import.

## Imported contracts

An imported contract is not rebaselined automatically. After rebuilding its artifact, run `etherplan import --id contract:name --rebaseline`. The saved address, inputs, and code hash must match, and the new artifact must verify the live contract. Etherplan reuses the recorded creation transaction as proof unless `--creation-tx` supplies another. It keeps import provenance and appends an artifact revision. Without `--rebaseline`, import rejects a changed artifact.

An artifact revision records provenance, not mutable storage. Declare getter checks for values that must still hold.

## Older beta plans

Top-level ABI entry order does not affect artifact identity, though the normalized ABI keeps its original order for transaction encoding. Parameter order still matters. Compared with v0.0.1-beta, this changes artifact hashes for nonempty ABIs. Regenerate old saved plans and rebaseline existing deployment state deliberately; do not edit saved hashes by hand.

[Previous: Creation proof](creation-proof.md) · [Validate and plan](../deploy/validate-and-plan.md)
