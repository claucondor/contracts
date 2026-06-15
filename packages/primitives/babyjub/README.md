# @claucondor/babyjub

BabyJubJub twisted Edwards curve operations on Flow EVM.

Provides the on-chain `BabyJub.sol` contract and a TypeScript SDK for off-chain operations and cross-VM call construction.

## Deployed contract

| Network | Address |
|---------|---------|
| Flow EVM testnet (chainId 545) | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |

## What is BabyJubJub?

BabyJubJub is a twisted Edwards elliptic curve embedded in the BN254 scalar field. It was designed by iden3 for use inside BN254 Groth16 ZK circuits, where BabyJubJub point operations cost only ~6 constraints — versus ~2 million constraints for BN254 EC ops.

The curve equation is `a*x^2 + y^2 = 1 + d*x^2*y^2` over `F_p`, where:
- `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`
- `a = 168700`
- `d = 168696`
- Identity element: `(0, 1)`

## Installation

```bash
npm install @claucondor/babyjub ethers
```

## TypeScript SDK

### Local operations (no network)

```typescript
import {
  GENERATOR_G,
  IDENTITY,
  CURVE_P,
  negatePoint,
  isOnCurveLocal,
  isIdentity,
  encodeBabyAdd,
  decodeBabyAddResult,
} from "@claucondor/babyjub";

// Check if a point is on the curve
const onCurve = isOnCurveLocal(GENERATOR_G.x, GENERATOR_G.y); // true

// Negate a point: -(x, y) = (P - x, y)
const negG = negatePoint(GENERATOR_G.x, GENERATOR_G.y);

// Encode calldata for cross-VM calls
const calldata = encodeBabyAdd(point1.x, point1.y, point2.x, point2.y);
```

### On-chain calls (against deployed contract)

```typescript
import {
  babyAddOnChain,
  isOnCurveOnChain,
  identityOnChain,
  negateOnChain,
  GENERATOR_G,
} from "@claucondor/babyjub";

// Add two points using the deployed contract
const g2 = await babyAddOnChain(GENERATOR_G, GENERATOR_G);
// g2 = { x: 1676417244..., y: 11563908930... }  (= 2G, verified against circomlibjs)

// Check on-chain
const onCurve = await isOnCurveOnChain(g2.x, g2.y); // true
```

## Solidity contract ABI

```solidity
// Twisted Edwards point addition — the core primitive
function babyAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
    public view returns (uint256 x3, uint256 y3)

// Curve membership check: a*x^2 + y^2 == 1 + d*x^2*y^2 (mod P)
function isOnCurve(uint256 x, uint256 y) public pure returns (bool)

// Returns identity element (0, 1)
function identity() public pure returns (uint256 x, uint256 y)

// Point negation: returns (P - x, y) for x != 0, (0, y) for x == 0
function negate(uint256 x, uint256 y) public pure returns (uint256 nx, uint256 ny)
```

Function selector for `babyAdd`: `0xa54a0868`

## Calling from Cadence (cross-VM)

```cadence
import "EVM"

transaction(x1: UInt256, y1: UInt256, x2: UInt256, y2: UInt256) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA")

        let calldata = EVM.encodeABIWithSignature(
            "babyAdd(uint256,uint256,uint256,uint256)",
            [x1, y1, x2, y2]
        )

        let result = coa.call(
            to: EVM.addressFromString("0x27139AFda7425f51F68D32e0A38b7D43BcB0f870"),
            data: calldata,
            gasLimit: 80_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(result.status == EVM.Status.successful)

        let decoded = EVM.decodeABI(
            types: [Type<UInt256>(), Type<UInt256>()],
            data: result.data
        )
        let x3 = decoded[0] as! UInt256
        let y3 = decoded[1] as! UInt256
    }
}
```

See `examples/cross-vm-call.cdc` for the full annotated example.

## Gas measurements (Flow EVM testnet)

| Function | Gas |
|----------|-----|
| `babyAdd(G, G)` | ~34,511 |
| `isOnCurve(G)` | ~23,660 |
| `negate(G)` | ~23,660 |
| `identity()` | ~21,600 |

`babyAdd` calls the `modexp` precompile (0x05) twice — once per denominator. Each call costs ~450 gas. The remaining gas is field arithmetic via `mulmod`/`addmod`.

## Testing

```bash
# Unit tests (no network)
npm test

# Integration tests against live testnet
RUN_INTEGRATION=1 npm test
```

## Reference test vectors

Computed by `circomlibjs@0.1.7` `buildBabyjub().addPoint()`:

| Operation | x | y |
|-----------|---|---|
| G | `995203...471134` | `547206...123905` |
| G + G (= 2G) | `167641...632953` | `115639...042842` |
| G + (-G) | `0` | `1` |
| 2G + G (= 3G) | `709797...502077` | `204600...481889` |

## Security

EXPERIMENTAL — not audited. Do not use with real funds. `BabyJub.sol` uses the EVM `modexp` precompile for field inverses (Fermat's little theorem). The contract is stateless and pure/view.

## License

MIT
