# Local modules

A project can call local modules. Each call creates a separate instance. A module can call another local module. One root project owns all instances, resources, state, journal, signer limits and recovery plans.

```hcl
chain_id = 31337

module "registry" {
  source = "./modules/registry"
  owner = "0x1111111111111111111111111111111111111111"
  mixer = "example/registry"
}

module "consumer" {
  source = "./modules/consumer"
  registry = module.registry.ready
  mixer = "example/consumer"
}
```

Each source directory has `main.ethp`. All `.ethp` files in that directory form the module. Declare inputs with ordinary `variable` blocks, including their types and defaults. A child inherits the root chain and CREATE2 factory. It cannot select a workspace, load variable overlays, or supply backend configuration. Only the root reads environment inputs and CLI flags. Artifact paths are relative to their defining source.

An input of type `any` can receive a constant record, for example `config = var.dai`. Inside the module, use `var.config.rate` or deeper field paths. These reads fold to constants in both value fields and constant fields such as `salt` and `code_hash`. Missing fields are errors; reading through `null` gives `null`.

Export values with `output` blocks:

```hcl
output "address" {
  value = contracts.registry.address
}

output "ready" {
  value = contracts.registry.address
  after = [calls.initialize]
}
```

The first output preserves the address reference. The second also carries the declared initialization prerequisite. A consumer of `ready` waits for `initialize`. It does not wait for unrelated work in the producer module. References remain symbolic in arguments, libraries, call targets, checks and ordering fields. A field that requires a constant rejects a resource reference.

Use `contracts.parent.created.implementation` for an existing pinned constructor result. The getter and CREATE nonce must be declared in `created_code`. The consumer waits for the verified parent and its child runtime. An address that becomes known only from an unplanned event or runtime read is not supported.

A planned factory call can create a separately pinned owned resource:

```hcl
resource "contract" "child" {
  artifact = "Child.json"
  address = var.predicted_child
  code_hash = var.child_code_hash
  created_by = calls.createChild
}

output "ready" {
  value = contracts.child.address
  after = [contracts.child]
}
```

The creator call must have a separate checked address equal to `child.address` and `before_absent = true`. A reference to this resource carries a live verification dependency, including an exported address without an explicit `after`. The root verifies the creator's postcondition and the child's artifact, runtime pin and checks before consumers sign. The verification step sends no transaction. It does not claim a general event-based creation proof. Supply a predictable address before planning.

Logical IDs use a length-prefixed module call path. The compiler rejects collisions with root resource names. Source paths do not enter logical IDs. Physical salts still come from the supplied mixer, label and generation. Calling one source twice requires distinct deployment inputs where the instances own distinct contracts. Module paths do not change salts automatically.

The ordinary `compile`, `plan`, `apply` and `verify` commands operate on the complete root. Saved plans pin the compiled inputs, outputs, source map and readiness. A changed compiled child invalidates a saved plan before signing. A new root plan checks declared consumers of changed outputs. It cannot prove compatibility that the declarations do not express.

Once a module root owns contracts, omitting or renaming one blocks planning. The state retains this rule if a later source removes its last module call. Historical calls are not contracts to destroy. A completed resource cannot silently acquire a currently unmet readiness prerequisite. Existing generation, provenance, artifact drift and recovery checks still apply. For pinned-runtime reuse, provide the root journal as well as state.

Modules do not have independent state, backend scopes, plans or applies. There is no module targeting, automatic ownership migration, remote source installer, loop expansion or chain rollback.
