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

## Keyed repetition

Set `for_each` to an expression that folds to a constant record. The module creates one instance per field, in key order. An empty record or `null` creates no instances. Use an empty or single-field record for an optional module. Lists and records containing resource references are not accepted.

```hcl
variable "bridges" { type = any }
variable "fee_row" { type = string }

module "portal" {
  source = "./modules/portal"
  for_each = var.bridges
  config = each.value
  mixer = each.value.mixer
}

module "bridge" {
  source = "./modules/bridge"
  for_each = var.bridges
  config = each.value
  portal = module.portal[each.key].ready
}

module "fees" {
  source = "./modules/fees"
  funder = module.bridge[var.fee_row].funder
}
```

Inside a repeated call's input expressions, `each.key` is the field name and `each.value` is its value. Read nested fields with `each.value.<field>`, using the same missing-field and null rules as variable field reads. `each` is not available outside that call's inputs, including its `for_each` expression or the child source. Pass values explicitly to child variables. A child may itself contain repeated calls whose records come from constant child inputs.

Keys must match `^[a-z0-9]{1,12}$`: one to twelve lowercase ASCII letters or digits, including a leading digit. Invalid keys are compile errors naming the key and this rule. `module.<name>[<key>].<output>` selects an instance. The key must fold to a constant string: a literal, `each.key`, `each.value.bridge`, `var.fee_row`, or a local expression can supply it. An unknown key is an error listing available keys, including `(none)` for an empty call. Single calls retain `module.<name>.<output>`; using the wrong form gives an error explaining the required syntax.

Selected outputs preserve symbolic references and only that instance's readiness in arguments, libraries, call targets, checks, ordering, module inputs and outputs. Keys and instance paths never enter salt derivation: supply distinct mixers or labels when distinct owned deployments require them. Adding, removing or reordering other keys cannot change an existing instance's identity. Removing a key that owns a contract still fails the module ownership check.

If `each.value` is `null` and is passed as a child input, it overrides a non-null child default. The default applies only when the input is omitted. Reading a field of that null input returns `null`.

`for_each` is reserved on module calls. A child variable named `for_each` is rejected with a rename hint. Repetition is not available on resources, variables or outputs. There is no `count`, splat syntax or module `enabled` attribute.

## Identity and compatibility

Projects using repetition write `modules.version: 2`. Each keyed path segment is an object: `module.x["a"]` has the path `["x", {"key":"a"}]`. Named path segments remain strings. Resource IDs length-prefix named segments and prefix key segments with `k`: resource `item` in that instance is `module2_1_x_k1_a_item`. A named child path `x.a` instead gives `module2_1_x_1_a_item`, so the paths cannot collide. Human plan labels and schedule entry labels show the instance with its key; state and saved plans retain logical IDs.

Projects without repetition continue to write and accept `modules.version: 1`, with exactly the same compiled specs, hashes and resource IDs. Existing state, journals and saved plans remain valid. Their formats do not change. Key ordering is deterministic; reordered record fields produce the same spec hash and do not invalidate a saved plan. Module metadata still pins each supplied input, even fields the child does not read.

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

Modules do not have independent state, backend scopes, plans or applies. There is no module targeting, automatic ownership migration, remote source installer or chain rollback.
