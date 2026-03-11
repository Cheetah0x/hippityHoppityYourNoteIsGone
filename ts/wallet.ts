import { SchnorrAccountContract } from "@aztec/accounts/schnorr"
import { EcdsaKAccountContract, EcdsaRAccountContract } from "@aztec/accounts/ecdsa"
import { AccountManager, SendOptions, Wallet } from "@aztec/aztec.js/wallet"
import { Account, BaseAccount, SignerlessAccount, type AccountContract, type Salt } from "@aztec/aztec.js/account"
import { Fr, Fq } from "@aztec/aztec.js/fields"
import { deriveMasterIncomingViewingSecretKey } from "@aztec/stdlib/keys"
import {
  ExecutionPayload,
  OffchainEffect,
  ProvingStats,
  Tx,
  TxHash,
  TxReceipt,
} from "@aztec/stdlib/tx"
// import { NoteDao, NotesFilter } from "@aztec/stdlib/note"
import { AztecNode, waitForTx } from "@aztec/aztec.js/node"
import { NO_WAIT, NoWait, SendInteractionOptions, WaitOpts } from "@aztec/aztec.js/contracts"
import { createPXE, getPXEConfig, PXE, PXEConfig, PXECreationOptions } from "@aztec/pxe/server"
import { GasSettings } from "@aztec/stdlib/gas"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { AccountFeePaymentMethodOptions } from "@aztec/entrypoints/account"
import { BaseWallet, type FeeOptions } from "@aztec/wallet-sdk/base-wallet"
import type { FieldsOf } from "@aztec/foundation/types"
import { inspect } from "util"
import { SimulationError } from "@aztec/stdlib/errors"

/**
 * Test-only wallet extension with unsafe utilities.
 *
 * WARNING: DO NOT USE IN PRODUCTION.
 *
 * This class extends ObsidionWallet with additional methods that are only
 * suitable for testing and development:
 * - createSchnorrAccount / createECDSAKAccount / createECDSARAccount: Create standard Aztec accounts
 * - proveTx: Prove transactions without sending (privacy risk)
 * - getNotes: Access internal note data (exposes contract internals)
 * - enableSimulatedSimulations: Toggle simulation mode
 */
export class ObsidionWalletTest extends BaseWallet {
  private simulatedSimulations = false

  constructor(pxe: PXE, node: AztecNode) {
    super(pxe, node)
  }

  /** Public test-only accessor for PXE. */
  getPxe(): PXE {
    return this.pxe
  }

  // Heper to add non-obsidion accounts to the wallet, e.g. test accounts.
  async setAccounts(accounts: Account[]) {
    for (const account of accounts) {
      this.accounts.set(account.getAddress().toString(), account)
    }
  }

  static async create(
    node: AztecNode,
    overridePXEConfig?: Partial<PXEConfig>,
    options: PXECreationOptions = { loggers: {} },
  ): Promise<ObsidionWalletTest> {
    const pxeConfig = Object.assign(getPXEConfig(), {
      proverEnabled: overridePXEConfig?.proverEnabled ?? false,
      ...overridePXEConfig,
    })
    // TODO: change this, this is a 200ms roundtrip to the node
    const l1Contracts = await node.getL1ContractAddresses()
    const rollupAddress = l1Contracts.rollupAddress
    pxeConfig.dataDirectory = pxeConfig.dataDirectory ?? `pxe-${rollupAddress}`

    const pxe = await createPXE(node, pxeConfig, options)
    return new ObsidionWalletTest(pxe, node)
  }
  protected accounts: Map<string, Account> = new Map();

  getAccounts() {
    return Promise.resolve(Array.from(this.accounts.values()).map(acc => ({ alias: '', item: acc.getAddress() })));
  }


  protected getAccountFromAddress(address: AztecAddress): Promise<Account> {
    let account: Account | undefined;
    if (address.equals(AztecAddress.ZERO)) {
      account = new SignerlessAccount();
    } else {
      account = this.accounts.get(address?.toString() ?? '');
    }

    if (!account) {
      throw new Error(`Account not found in wallet for address: ${address}`);
    }

    return Promise.resolve(account);
  }

  // -- Account Creation (TEST ONLY) --
  /**
   * Create a Schnorr account for testing purposes.
   * This creates a standard Aztec Schnorr account (not an Obsidion account).
   *
   * @param secret - The secret key for the account
   * @param salt - The salt for contract deployment
   * @param signingKey - Optional signing key (derived from secret if not provided)
   * @returns AccountManager for the created account
   */
  async createSchnorrAccount(secret: Fr, salt: Salt, signingKey?: Fq): Promise<AccountManager> {
    const sk = signingKey ?? deriveMasterIncomingViewingSecretKey(secret)
    const contract = new SchnorrAccountContract(sk)
    return await this.createTestAccountInternal(secret, salt, contract)
  }

  /**
   * Create an ECDSA K256 (secp256k1) account for testing purposes.
   * This creates a standard Aztec ECDSA account (not an Obsidion account).
   *
   * @param secret - The secret key for the account
   * @param salt - The salt for contract deployment
   * @param signingKey - The ECDSA signing key buffer
   * @returns AccountManager for the created account
   */
  async createECDSAKAccount(secret: Fr, salt: Salt, signingKey: Buffer): Promise<AccountManager> {
    const contract = new EcdsaKAccountContract(signingKey)
    return await this.createTestAccountInternal(secret, salt, contract)
  }

  /**
   * Create an ECDSA R256 (secp256r1) account for testing purposes.
   * This creates a standard Aztec ECDSA account (not an Obsidion account).
   *
   * @param secret - The secret key for the account
   * @param salt - The salt for contract deployment
   * @param signingKey - The ECDSA signing key buffer
   * @returns AccountManager for the created account
   */
  async createECDSARAccount(secret: Fr, salt: Salt, signingKey: Buffer): Promise<AccountManager> {
    const contract = new EcdsaRAccountContract(signingKey)
    return await this.createTestAccountInternal(secret, salt, contract)
  }

  /**
   * Internal helper to create test accounts.
   */
  private async createTestAccountInternal(
    secret: Fr,
    salt: Salt,
    contract: AccountContract,
  ): Promise<AccountManager> {
    const accountManager = await AccountManager.create(this as unknown as Wallet, secret, contract, salt)
    const instance = await accountManager.getInstance()
    const artifact = await accountManager.getAccountContract().getContractArtifact()
    // Register both contract metadata and account secret so PXE can fetch/decrypt account notes.
    await this.registerContract(instance, artifact, secret)
    this.accounts.set(accountManager.address.toString(), await accountManager.getAccount())
    return accountManager
  }



  // -- Simulated Simulations Toggle --

  /**
   * Enable the "simulated simulation" path for simulateTx.
   * When enabled, simulations use TypeScript emulation instead of actual circuit execution.
   *
   * WARNING: Not cryptographically sound - only for testing speed.
   */
  enableSimulatedSimulations(): void {
    this.simulatedSimulations = true
  }

  /**
   * Disable the "simulated simulation" path for simulateTx.
   */
  disableSimulatedSimulations(): void {
    this.simulatedSimulations = false
  }

  /**
   * Check if simulated simulations are enabled.
   */
  isSimulatedSimulationsEnabled(): boolean {
    return this.simulatedSimulations
  }

  // -- Unsafe Testing Utilities --

  /**
   * Prove a transaction without sending it.
   *
   * WARNING: DO NOT USE IN PRODUCTION.
   * Proven transactions can be intercepted and tracked by malicious nodes.
   * This also makes it difficult for the wallet to track the interaction.
   *
   * @param exec - The execution payload to prove
   * @param opts - The options to configure the interaction
   * @returns A proven transaction ready to be sent
   */
  async proveTx(exec: ExecutionPayload, opts: SendOptions): Promise<ProvenTx> {
    const fee = await this.completeFeeOptions(opts.from, exec.feePayer, opts.fee?.gasSettings)
    const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(exec, opts.from, fee)
    const txProvingResult = await this.pxe.proveTx(txRequest, this.scopesFor(opts.from))
    return new ProvenTx(
      this.aztecNode,
      await txProvingResult.toTx(),
      txProvingResult.getOffchainEffects(),
      txProvingResult.stats,
    )
  }

  /**
   * Get notes based on the provided filter.
   *
   * WARNING: DO NOT USE IN PRODUCTION.
   * This exposes contract internal implementation details.
   * Use contract-specific getter functions instead (e.g., get_balance on Token contract).
   *
   * @param filter - The filter to apply to the notes
   * @returns The requested notes
   */
  // TODO: implement this with our own pxe
  // getNotes(filter: NotesFilter): Promise<NoteDao[]> {
  //   return this.pxe.getNotes(filter)
  // }

  /**
   * Stop the PXE service.
   * Useful for cleanup in tests.
   */
  async stop(): Promise<void> {
    await this.pxe.stop()
  }
}

export type ProvenTxSendOpts = {
  wait?: NoWait | WaitOpts
}

export type ProvenTxSendReturn<T extends NoWait | WaitOpts | undefined> = T extends NoWait
  ? TxHash
  : TxReceipt

/**
 * A proven transaction that can be sent to the network. Returned by the `prove` method of the test wallet
 */
export class ProvenTx extends Tx {
  constructor(
    private node: AztecNode,
    tx: Tx,
    public offchainEffects: OffchainEffect[],
    public stats?: ProvingStats,
  ) {
    super(
      tx.getTxHash(),
      tx.data,
      tx.chonkProof,
      tx.contractClassLogFields,
      tx.publicFunctionCalldata,
    )
  }

  send(options?: Omit<ProvenTxSendOpts, "wait">): Promise<TxReceipt>
  send<W extends ProvenTxSendOpts["wait"]>(
    options: ProvenTxSendOpts & { wait: W },
  ): Promise<ProvenTxSendReturn<W>>
  async send(options?: ProvenTxSendOpts): Promise<TxHash | TxReceipt> {
    const txHash = this.getTxHash()
    await this.node.sendTx(this).catch((err) => {
      throw this.contextualizeError(err, inspect(this))
    })

    if (options?.wait === NO_WAIT) {
      return txHash
    }

    const waitOpts = typeof options?.wait === "object" ? options.wait : undefined
    return await waitForTx(this.node, txHash, waitOpts)
  }

  private contextualizeError(err: Error, ...context: string[]): Error {
    let contextStr = ""
    if (context.length > 0) {
      contextStr = `\nContext:\n${context.join("\n")}`
    }
    if (err instanceof SimulationError) {
      err.setAztecContext(contextStr)
    }
    return err
  }
}


