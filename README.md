# Aztec FPC Note-Count Repro

Something aint right with the private transfer in the setup phase

## What this demonstrates

The test runs the same flow twice with identical total token balance:

- Scenario A: mint recipient funds as **1 private note**
- Scenario B: mint recipient funds as **2 private notes**

Then it executes a transfer that uses `FPCFeePaymentMethod` and prints a side-by-side table:

- transfer success/error
- recipient final private balance
- receiver final private balance
- operator final private balance

If we mint one note at the start. Balance is gone
If we mint 2 notes. All beuno

## Requirements

- Node.js 20+
- Yarn 4 (`packageManager` is pinned to `yarn@4.5.3`)
- Aztec sandbox running at `http://localhost:8080`
- Anvil (L1 RPC) running at `http://localhost:8545`

## Install

```bash
yarn install
```

## Run the repro test

```bash
yarn test ts/test.test.ts
```

If your shell does not pass file args through `yarn test`, run:

```bash
yarn vitest run ts/test.test.ts
```

## Expected output

Look for:

- `=== Note-count demonstration ===`
- a `console.table` with rows for `notesMinted: 1` and `notesMinted: 2`

The test asserts the final balances differ between those two rows.

## Main files

- `ts/test.test.ts` - integration repro + scenario table output
- `ts/FPCPaymentMethod.ts` - custom fee payment method used in transfer flow
- `ts/wallet.ts` - test wallet wrapper around Aztec wallet primitives
- `contract/fpc/src/main.nr` - Noir contract used by the fee payment path
