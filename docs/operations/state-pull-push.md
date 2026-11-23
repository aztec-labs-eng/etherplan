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

## Move resources between scopes with state mv

`state mv` moves one resource from one pulled scope file to another and gives it another resource ID. It works like Terraform's `state mv` between two state files. Use it to bring the resources of several scopes into one scope, for example when one root project takes over the contracts of several projects.

```sh
etherplan state pull --backend unit-backend.json --out unit.json
etherplan state mv --in unit.json --out root.json --from contract:registry --to contract:module1_4_unit_registry
etherplan state push --backend root-backend.json --in root.json
```

It reads no backend and no chain. It reads and writes only the two files. Run it one time for each resource.

- State goes to state. The state record leaves the `--in` file and goes into the `--out` file under the `--to` ID. The record itself does not change.
- Journal goes to journal. Each journal record of that resource goes into the journal of the `--out` file as a `moved` record. A `moved` record holds the old record, unchanged, and the scope and the resource ID that it had. The journal of the `--in` file does not change, because its hash chain can't be cut.
- The saved plans that those journal records name go along.

`state mv` makes the `--out` file when it is absent. The new file has the scope names and the chain of the `--in` file. `state push` ignores those names: it writes into the scope of its backend file.

A plan in the target reuses a moved contract. A replay proof needs only the state record. A pinned-runtime proof also needs its journal records, and its commitment includes the resource ID that the contract had. The plan finds both in the `moved` records. The scope then holds all its evidence, so a later `state pull` and `state push` move it complete, and the source backend is not needed again.

`state mv` refuses when:

- the `--in` journal fails the hash-chain check.
- the `--in` file doesn't have the `--from` resource, or the `--out` file already has the `--to` resource.
- the two files name different chains.
- the record isn't valid under the `--to` ID, for example a contract record under a call ID.

It doesn't check the target project. Move only the resources that the target project declares: a module root stops on a contract in its state that it doesn't declare. `state mv` writes no signer-index rows, so move a resource only after its transactions have the confirmation depth that your applies use.

[Previous: AWS CLI setup](aws-cli.md) · [Next: KMS transaction signers](kms-signers.md)
