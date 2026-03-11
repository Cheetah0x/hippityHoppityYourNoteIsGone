/**
 * Integration demonstration: private note fragmentation affects fee+transfer behavior.
 *
 * This test runs the same flow twice with identical total minted balance:
 * - Scenario A: mint as 1 private note
 * - Scenario B: mint as 2 private notes
 *
 * It then performs the same transfer using `FPCFeePaymentMethod` and prints a
 * side-by-side table of outcomes (success/error and end balances). This makes
 * the note-count sensitivity visible in one test run.
 */
import { beforeAll, it, describe, expect } from "vitest"
import { BaseAccount } from "@aztec/aztec.js/account"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { AztecNode, createAztecNodeClient } from "@aztec/aztec.js/node"
import { getInitialTestAccountsData, InitialAccountData } from "@aztec/accounts/testing"
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC"
import {
  Contract,
  ContractInstanceWithAddress,
  SendInteractionOptions,
} from "@aztec/aztec.js/contracts"
import { Fr } from "@aztec/aztec.js/fields"

import dotenv from "dotenv"
import { GasSettings } from "@aztec/stdlib/gas"
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee"
import { ContractArtifact } from "@aztec/aztec.js/abi"
import { TokenContract } from "@aztec/noir-contracts.js/Token"
import { mnemonicToAccount } from "viem/accounts"
import { createPXE, getPXEConfig, PXE, PXEConfig, PXECreationOptions } from "@aztec/pxe/server"
import { ObsidionWalletTest } from "./wallet"
import { FPCFeePaymentMethod } from "./FPCPaymentMethod"
import { getSponsoredFeePaymentMethod, getSponsoredFPCInstance } from "./utils/sponsorFPC"
import { Wallet } from "@aztec/aztec.js/wallet"
import { createExtendedL1Client } from "@aztec/ethereum/client"
import { createEthereumChain } from "@aztec/ethereum/chain"
import { L1FeeJuicePortalManager } from "@aztec/aztec.js/ethereum"
import { FeeJuiceContract } from "@aztec/noir-contracts.js/FeeJuice"
import { createLogger } from "@aztec/foundation/log"
import { FPCContract } from "./utils/FPC"
import { waitForL1ToL2MessageReady } from "@aztec/aztec.js/messaging"
import { TxReceipt } from "@aztec/aztec.js/tx"



const SANDBOX_URL = "http://localhost:8080"
const FEE_JUICE_AMOUNT = 1000000000000000000000n // 1e18
const INITIAL_BALANCE = 1000000000000000000000000n
const MNEMONIC = "test test test test test test test test test test test junk"
const L1_RPC_URL = "http://localhost:8545"
const TRANSFER_AMOUNT = 10000n
const L1_CHAIN_ID = 31337

describe("QuoteFPC Integration Test", () => {
  let deployerAccount: BaseAccount
  let wallet: ObsidionWalletTest
  let deployOptions: SendInteractionOptions
  let recipientAccount: BaseAccount
  let otherAccount: BaseAccount
  let node: AztecNode
  let accountsData: InitialAccountData[]
  let sponsoredFeePaymentMethod: SponsoredFeePaymentMethod
  let fpc: Contract

  beforeAll(async () => {
    // --- Setup Aztec sandbox ---
    node = createAztecNodeClient(SANDBOX_URL)

    const pxeConfig = Object.assign(getPXEConfig(), {
      proverEnabled: false,
    })
    // TODO: change this, this is a 200ms roundtrip to the node
    const l1Contracts = await node.getL1ContractAddresses()
    const rollupAddress = l1Contracts.rollupAddress
    pxeConfig.dataDirectory = pxeConfig.dataDirectory ?? `pxe-${rollupAddress}`

    const pxe = await createPXE(node, pxeConfig)

    wallet = new ObsidionWalletTest(pxe, node)

    accountsData = await getInitialTestAccountsData()
    const accounts = await Promise.all(
      accountsData.map(async (accountData) => {
        const manager = await wallet.createSchnorrAccount(
          accountData.secret,
          accountData.salt,
          accountData.signingKey,
        )
        const completeAddress = await manager.getCompleteAddress()
        return manager.getAccountContract().getAccount(completeAddress) as BaseAccount
      }),
    )

    deployerAccount = accounts[0]
    recipientAccount = accounts[1]
    otherAccount = accounts[2]

    //register the senders
    await wallet.registerSender(deployerAccount.getAddress())
    await wallet.registerSender(recipientAccount.getAddress())
    await wallet.registerSender(otherAccount.getAddress())


    // sponsor just for the deployment of the token
    const sponsoredFPCInstance = await getSponsoredFPCInstance()
    await wallet.registerContract(
      sponsoredFPCInstance,
      SponsoredFPCContractArtifact,
    )

    sponsoredFeePaymentMethod = await getSponsoredFeePaymentMethod(wallet.getPxe())
    deployOptions = {
      from: deployerAccount.getAddress(),
      fee: { paymentMethod: sponsoredFeePaymentMethod },
    }

    // deploy the fpc
    const hdAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 0 })
    const l1Client = createExtendedL1Client(
      [L1_RPC_URL],
      hdAccount,
      createEthereumChain([L1_RPC_URL], L1_CHAIN_ID).chainInfo,
    )

    const portalManager = await L1FeeJuicePortalManager.new(
      node,
      l1Client,
      createLogger("FeeJuice"),
    )

    const feeJuiceContract = FeeJuiceContract.at(
      (await node.getProtocolContractAddresses()).feeJuice,
      wallet as unknown as Wallet,
    )

    // fpc artifact

    //deploy the fpc
    fpc = await FPCContract.deploy(wallet as unknown as Wallet).send(deployOptions)

    expect(fpc).toBeDefined()

    const result = await portalManager.bridgeTokensPublic(
      fpc.address,
      FEE_JUICE_AMOUNT,
      true,
    )

    await sendEmptyTxs(wallet, deployerAccount, 2)

    await waitForL1ToL2MessageReady(node, Fr.fromHexString(result.messageHash), {
      timeoutSeconds: 120,
      forPublicConsumption: true,
    })

    const claim = await feeJuiceContract.methods
      .claim(fpc.address, result.claimAmount, result.claimSecret, result.messageLeafIndex)
      .send({ from: deployerAccount.getAddress() })

    expect(claim).toBeDefined()

    const balance = await feeJuiceContract.methods
      .balance_of_public(fpc.address)
      .simulate({ from: deployerAccount.getAddress() })

    console.log("AppAttestFPC fee juice balance:", balance.toString())
    expect(balance).toBe(FEE_JUICE_AMOUNT)
  }, 1000000)

  it("demonstrates note-count effect on final balances", async () => {
    const scenarioNoteCounts = [1, 2]
    const rows: Array<{
      notesMinted: number
      transferSucceeded: boolean
      recipientBefore: string
      recipientAfter: string
      receiverAfter: string
      operatorAfter: string
      error: string
    }> = []

    for (const notesToMint of scenarioNoteCounts) {
      const tokenContract = await TokenContract.deploy(
        wallet as unknown as Wallet,
        deployerAccount.getAddress(),
        "USDC",
        "USDC",
        18n,
      ).send(deployOptions)

      const tokenAddress = tokenContract.address
      const share = INITIAL_BALANCE / BigInt(notesToMint)

      for (let i = 0; i < notesToMint; i++) {
        await tokenContract.methods
          .mint_to_private(recipientAccount.getAddress(), share)
          .send(deployOptions)
      }

      const paymentMethod = new FPCFeePaymentMethod(
        fpc.address,
        recipientAccount.getAddress(),
        tokenAddress,
        deployerAccount.getAddress(),
        wallet,
        GasSettings.default({
          maxFeesPerGas: await node.getCurrentMinFees(),
        }),
      )

      const sendOptions: SendInteractionOptions = {
        from: recipientAccount.getAddress(),
        fee: { paymentMethod },
      }

      const recipientBefore = await tokenContract.methods
        .balance_of_private(recipientAccount.getAddress())
        .simulate({ from: recipientAccount.getAddress() })

      let transferSucceeded = false
      let error = ""
      try {
        await tokenContract.methods
          .transfer(otherAccount.getAddress(), TRANSFER_AMOUNT)
          .send(sendOptions)
        transferSucceeded = true
      } catch (err) {
        error = err instanceof Error ? err.message.split("\n")[0] : String(err)
      }

      const recipientAfter = await tokenContract.methods
        .balance_of_private(recipientAccount.getAddress())
        .simulate({ from: recipientAccount.getAddress() })
      const receiverAfter = await tokenContract.methods
        .balance_of_private(otherAccount.getAddress())
        .simulate({ from: otherAccount.getAddress() })
      const operatorAfter = await tokenContract.methods
        .balance_of_private(deployerAccount.getAddress())
        .simulate({ from: deployerAccount.getAddress() })

      rows.push({
        notesMinted: notesToMint,
        transferSucceeded,
        recipientBefore: recipientBefore.toString(),
        recipientAfter: recipientAfter.toString(),
        receiverAfter: receiverAfter.toString(),
        operatorAfter: operatorAfter.toString(),
        error,
      })
    }

    console.log("\n=== Note-count demonstration ===")
    console.table(rows)
    console.log("Interpretation: compare notesMinted=1 vs notesMinted=2 rows.")

    // We want this test to be a demonstration, but still guard that final outcomes differ.
    expect(rows.length).toBe(2)
    expect(rows[0].recipientAfter).not.toBe(rows[1].recipientAfter)
    expect(rows[0].receiverAfter).not.toBe(rows[1].receiverAfter)
    expect(rows[0].operatorAfter).not.toBe(rows[1].operatorAfter)
  }, 10000000)


const sendEmptyTx = async (
  wallet: ObsidionWalletTest,
  account: BaseAccount,
): Promise<TxReceipt> => {
  console.log("sendEmptyTx...")

  const paymentMethod = await getSponsoredFeePaymentMethod(wallet.getPxe())

  const feeJuiceContract = FeeJuiceContract.at(
    (await node.getProtocolContractAddresses()).feeJuice,
    wallet as unknown as Wallet,
  )

  return await feeJuiceContract.methods.check_balance(0n).send({
    from: account.getAddress(),
    fee: {
      paymentMethod,
    },
  })
}

const sendEmptyTxs = async (wallet: ObsidionWalletTest, account: BaseAccount, count: number) => {
  for (let i = 0; i < count; i++) {
    const currentBlock = await node.getBlockNumber()
    await sendEmptyTx(wallet, account)

    // Wait for block to increment
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 500)) // Wait 0.5 seconds
      const newBlock = await node.getBlockNumber()
      if (newBlock > currentBlock) {
        break
      }
    }
  }
}

})

