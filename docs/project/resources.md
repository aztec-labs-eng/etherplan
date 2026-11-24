# Resource types

Part of [Project files](index.md).

A project has at least one contract, external or call. Each `resource` block has a type and a name; names become IDs such as `contract:registry` or `call:setOwner`.

| Type       | Required fields                                                                                                  | Purpose                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `contract` | `artifact`; exactly one of `address` or `salt`; `args` when deploying; optional `generation` with a derived salt | Adopt an address or deploy compiled code through CREATE2.                                                                |
| `external` | `address`                                                                                                        | Verify an address managed outside Etherplan.                                                                             |
| `call`     | `target`, `method`, `args`, and one or more check blocks                                                         | Run a declared method only when its before checks allow it, then verify all desired results.                             |
| `check`    | `target` and getter expectations                                                                                 | Attach read-only checks to a contract, external, or call. It is folded into the target, not planned as its own resource. |

## Contracts and externals

`artifact` is a compiled JSON path relative to `main.ethp`. Optional `source` and `name` must match the artifact's identities. A deployable contract needs `args`, including `[]` for a zero-argument constructor. Optional `libraries` links compiled libraries; `after` orders it after verified resources. `code_hash` pins expected runtime code. `signer_role` selects a signer, and `sender_independent = true` allows an eligible deployment to use a secondary deployer. See [pinned runtime](../recovery/stateful-constructors.md) for `creation_proof_mode` and `created_code`. A contract adopted by `address` with a `code_hash` can set `ignore_metadata = true` to compare runtimes without their CBOR metadata tails; see [verify an existing contract](../verify/existing-contracts.md#different-builds).

An owned contract at a predictable address can set `created_by = calls.createChild` with an artifact and runtime pin. Its creator must use a checked result at that address and `before_absent = true`. The root verifies the created contract after the call and before its consumers. See [Local modules](modules.md).

An external may add `code_hash` and getter checks. If it has checks, supply an `abi`. Writes that reference an external wait for its verification. A top-level `factory` block can specify the CREATE2 factory address and code hash; automated apply still requires the bundled runtime.

## Calls and checks

A call targets a declared contract, a declared external, or a pinned constructor-created child. For a child, use `target = contracts.executor.created.SUBSIDY` and supply the child ABI in the call. The getter must be declared in the parent's `created_code`; the parent proof must verify the child's CREATE address and runtime. An external target needs an ABI, either on the external or on the call.

Each call check must set `getter`, one before condition, and one after condition, with optional getter `args`. The getter must be `view` or `pure` in the ABI. Use `before` for a returned value and `equals` for the desired returned value. Calls may add `after`, `signer_role`, `owner_only`, or `transfers_ownership`; see [ordering](../dependencies/ordering-and-assumptions.md).

Use `before_revert = { error = "Missing", args = [var.key] }` when the getter must report a specific custom error before the call. Use `after_revert` instead of `equals` when the getter must report a specific custom error afterward. The error name must identify exactly one error in the call ABI. Its arguments must encode with that ABI. Etherplan compares the complete revert bytes, including the arguments. An unrelated error, an empty response, or a provider failure does not satisfy the condition. Choose exactly one of `before`, `before_revert`, and `before_absent`, and exactly one of `equals` and `after_revert`.

Several check blocks can target the same call. They read the same checked address at one block. Etherplan skips the call only when every after condition matches. Otherwise, every before condition must match before the call can proceed. An unchanged value can satisfy both conditions. A mixture that matches neither complete snapshot is a conflict. After the call, every after condition must match at the receipt block before Etherplan records success. Checks are part of the saved plan and its identity. Existing single-check specs and saved records keep their shape.

For example, one call can configure two entries whose getter reports `Missing(key)` until each entry exists:

```hcl
resource "call" "configure" {
  target = contracts.table
  method = "configure"
  args = [10, 20]
}

resource "check" "first" {
  target = calls.configure
  getter = "row"
  args = [1]
  before_revert = { error = "Missing", args = [1] }
  equals = 10
}

resource "check" "second" {
  target = calls.configure
  getter = "row"
  args = [2]
  before_revert = { error = "Missing", args = [2] }
  equals = 20
}
```

A call check can set `address` to read its postcondition at another address. Use `before_absent = true` instead of `before` when that address must have no code before the call. This supports a factory call whose getter belongs to the created contract. If code already exists, its getter must equal the desired value; a different value is a conflict. The call verification code hash is the hash at the checked address.

Grouped checks must use one checked address and cannot use `before_absent`. Keep a creator call with `before_absent` as a single-check call.

Named `signer_role` values select the role addresses pinned by the plan. Use `--named-signers` for CLI planning and scheduling. Roles that share an address share one nonce lane, while signatures still use each role's configured signer service.

A check on a contract or external can list getter names and expected values, and several check blocks may target the same resource. Each getter can appear only once. For a getter whose name is reserved by the check syntax, use `getter = "target"` and `equals = …`. Any resource can use `enabled = <condition>` to leave it out of the compiled spec.

[Previous: Syntax](syntax-and-resources.md) · [Next: One project for several chains](multi-chain.md) · [Complete example](hcl.md)
