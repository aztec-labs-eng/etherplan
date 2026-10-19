# Verify or import an existing contract

Part of [Verify contracts](index.md).

`verify` rereads live code, immutables, declared getter values, external code hashes, and binding state. Matching bytecode outside compiler-marked immutable regions is not enough when an immutable has no value proof. Incomplete proof is `unverified`; a mismatch is `conflict`.

Checks must name `view` or `pure` ABI functions. A check proves the declared return value at the block used for verification.

## Different builds

A contract that another build deployed can match its artifact everywhere except the CBOR metadata tail, for example after a compiler setting such as `bytecode_hash` changed or a shared source file changed. Etherplan treats that as a `conflict`, because the code comes from a different build.

A contract adopted by `address` can set `ignore_metadata = true` to accept it. Etherplan then strips the metadata tail from the artifact runtime and the live runtime and compares the rest as usual, including immutables and library links. The setting requires a `code_hash`, which still pins the exact live bytes, tail included, and proves its immutables. The verification result records the method `metadata-stripped-runtime` and keeps both tails in `evidence.ignoredMetadata`. A runtime without a decodable tail is compared byte for byte.

A CREATE2 deployment cannot set `ignore_metadata`, because its address commits to the whole initcode, metadata included.

```hcl
resource "contract" "registry" {
  artifact        = "out/Registry.sol/Registry.json"
  address         = var.registry
  code_hash       = var.registryCodeHash
  ignore_metadata = true
}
```

## Import

Use `import --id contract:name` to adopt a verified existing contract into local state. For a direct CREATE deployment with a private immutable, pass `--creation-tx 0x…` when the creation transaction is needed as proof. Import sends no transaction.

[Next: Import an existing contract](import.md) · [Write checks](../project/syntax-and-resources.md)
