# Remove resources from state

Part of [Shared deployment operations](index.md).

`etherplan state rm` makes state forget resources. It sends no transaction: each contract stays on chain, and the journal keeps every record. Terraform's `terraform state rm` does the same.

Use it when a root stops managing contracts it owns, for example when another root takes over one of its modules. A [module root](../project/modules.md) refuses to plan once it stops calling a contract it owns, and the error lists those contracts. Remove the module call from the project first. Then remove its resources from state, and plan again:

```sh
etherplan plan --backend backend.json --deployers 0xYourDeployer --max-spend-wei 100000000000000000
# Module root omitted owned contracts: contract:module1_5_moved_item. ...
etherplan state rm --backend backend.json --resources contract:module1_5_moved_item
etherplan plan --backend backend.json --deployers 0xYourDeployer --max-spend-wei 100000000000000000
```

Without `--backend`, it edits the local state file, as `plan` and `apply` would read it. Run it from the project directory, with the variables and workspace of the deployment.

## What it checks

Name every resource by its ID, separated by commas. Every resource of one module instance shares the instance's prefix, such as `module1_5_moved_`. The resources include calls and externals, which the planning error doesn't list, so read the state's `resources` for the complete list.

With a contract, `state rm` also removes its calls: each call record on the address of that contract, which is a call on the contract or the call that created it. It keeps a call that the project still declares, because a root can call a contract that it no longer owns. The report lists the calls that it removed. It removes no other record that you didn't name: name each external, and each call that has another target.

`state rm` changes nothing when one of these is true:

- The project still declares a named resource. The next plan would deploy or call it again, so remove it from the project first.
- A plan has an unresolved transaction in the journal. Resume it with `apply` first, because a removal would leave that plan stale with its transaction in flight.
- The state has no resource with a named ID, or the state is missing.

A removal also drops the state's last plan hash. A plan made before it can't be applied afterward, so make a new one.

## Locks

Locally, `state rm` holds the state lock that `apply` holds. In AWS, it takes the deployment lease and a lease for each signer in the scope's journal, as `apply` does, or the zero address when nothing in the scope has signed. It writes the state with a compare-and-swap on its version. It needs `ETH_RPC_URL` for the chain identity of the scope, and the `init` marker. It reads the journal without decrypting signed bytes, so it needs no S3 access and no KMS encryption or decryption.

There is no undo command. Keep a copy of a local state file before removing from it. In AWS, the table's point-in-time recovery keeps earlier versions of the state item.

[Previous: Programmatic apply](programmatic-apply.md) · [Deployment scope](scope-and-recovery.md)
