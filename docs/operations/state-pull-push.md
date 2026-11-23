# Move a deployment scope with state pull and push

Part of [Shared deployment operations](index.md).

`state pull` and `state push` move one deployment scope from one AWS backend to another, for example when a deployment moves to another AWS account. They work like Terraform's commands of the same name. Pull writes the scope to a file with the source's credentials. Push writes that file into the target with the target's credentials. No step needs both accounts at once.

```sh
AWS_PROFILE=source etherplan state pull --backend source-backend.json --out scope.json
AWS_PROFILE=target etherplan state push --backend target-backend.json --in scope.json
```

Each backend file is an ordinary [backend config](aws-cli.md) with its own table, bucket, and KMS key, and its `scope` names the deployment on that side. The two scopes usually match. A different target scope, with `--resources`, moves part of a deployment into another project. `ETH_RPC_URL` selects the chain, and both scopes must be on it. The AWS SDK finds the credentials and the region as usual, so set `AWS_PROFILE` and `AWS_REGION` for each command.

Later plans in the target reuse the deployed contracts. They check creation proofs, pinned-runtime proofs included, against the pushed journal.

## What the file holds

- The state.
- Every journal record, unchanged. Signed transaction bytes stay encrypted under the source's KMS key.
- The saved plans the journal names, when the source has a plan bucket, and the hashes of any plans the bucket lacks.

The file holds no plaintext signatures, but it does hold the deployment's plans and history. Pull writes it readable by its owner only.

## What push writes

- The saved plans, into the target's plan bucket.
- Every journal record, through the target's normal append, so the journal head and the signer index follow. A repaired journal can sign one transaction under two actions; push still writes one signer-index row for it.
- The state, last. With `--resources` it writes only the named resources. The whole journal always goes, because its hash chain can't be cut.

The target never needs the source's key. Apply decrypts only the signatures of the plan it applies and of unresolved transactions, and a pushed scope has neither. Apply a new plan in the target: a plan that signed in the source can't be applied again there.

## When they refuse

Pull refuses when:

- the scope has an unresolved transaction. Settle it with `apply` in the source backend first.
- the scope has no state.
- the state or the journal head moved during the pull. Freeze deploys and pull again.

Push refuses when:

- the file isn't from `state pull`, or its journal fails the hash-chain check.
- the journal has an unresolved transaction.
- the target scope names another chain.
- `--resources` names a resource the state doesn't have.
- the file has saved plans and the target has no plan bucket.
- the target scope already has state.
- the target journal isn't a prefix of the file's journal.

Push never overwrites a scope. While it writes the journal and the state, it holds a deployment lease and a lease for each signer of the scope in the target. If it stops partway, run it again: it resumes after the last record it wrote. At the end it rereads the target and fails if the target doesn't read back as pushed. Pull never writes the source.

## Reports

Each command prints a JSON report: the scope key, the record count, the signed records and their signers, the resources, the state hash, the journal head, and the plans carried or missing. Push adds the pulled scope key and where it resumed. Compare the two reports, and keep them as the record of the move.

Push can't see the source, so a deploy in the source after the pull never reaches the target. Freeze deploys in the source from the pull onward, and stop planning the scope there once the push succeeds. Both backends then hold the same signer history, and two backends that sign with one key can both use a nonce. See [AWS permissions](permissions.md) for what each side needs.

[Previous: AWS CLI setup](aws-cli.md) · [Next: KMS transaction signers](kms-signers.md)
