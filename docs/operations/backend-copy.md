# Copy a deployment scope to another backend

Part of [Shared deployment operations](index.md).

`backend-copy` moves one deployment scope from one AWS backend to another, for example when a deployment moves to another AWS account. The target takes the scope over as the source left it. Later plans in the target reuse the deployed contracts and verify their creation proofs, pinned-runtime proofs included, from the copied journal.

```sh
etherplan backend-copy \
  --from source-backend.json --from-profile source --from-region us-east-1 \
  --to target-backend.json --to-profile target --to-region eu-west-2
```

Each file is an ordinary [backend config](aws-cli.md) with its own table, bucket, and KMS key, and its `scope` names the deployment on that side. The two scopes usually match. A different target scope moves part of a deployment into another project. `ETH_RPC_URL` selects the chain, and both scopes must be on it. Each side's clients use its profile and region. Without them, the AWS SDK defaults apply: the default credentials, and the region from `AWS_REGION` or else the profile. `AWS_REGION` applies to both sides, so pass both regions when the backends sit in different regions.

## What it copies

- Every journal record, unchanged, through the target's normal append, so the journal head and the signer index follow.
- One signer-index row per transaction, even when a repaired journal signs one transaction under two actions.
- The state, or with `--resources` only the named resources. The whole journal is always copied, because its hash chain can't be cut.
- The saved plans the journal names, when both backends have a plan bucket.

Signed transaction bytes stay encrypted under the source's KMS key, so the target never needs that key. Apply decrypts only the signatures of the plan it applies and of unresolved transactions, and a copied scope has neither. Apply a new plan in the target: a plan that signed in the source can't be applied again there.

## When it refuses

- The source has an unresolved transaction. Settle it with `apply` in the source backend, and freeze deploys while you copy.
- The source has no state.
- The target already has state.
- The target journal isn't a prefix of the source journal.
- The target scope names another chain.
- `--resources` names a resource the source state doesn't have.

While it writes, the copy holds a deployment lease and a lease for each signer of the scope in the target. If it stops partway, run the same command again: it resumes after the last record it wrote. At the end it rereads both sides. It fails if the source state or journal head moved during the copy, or if the target doesn't read back as copied. The source is never written.

The command prints a JSON report: both scope keys, the record count, where it resumed, the signed records and their signers, the copied resources, the state hash, the journal head, and the plans copied or missing in the source. Keep it as the record of the move.

After the copy, stop planning the scope from the source. Both backends now hold the same signer history, and two backends that sign with one key can both use a nonce. See [AWS permissions](permissions.md) for what each profile needs.

[Previous: AWS CLI setup](aws-cli.md) · [Next: KMS transaction signers](kms-signers.md)
