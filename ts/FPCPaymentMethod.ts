import { FeePaymentMethod } from "@aztec/aztec.js/fee"
import { Fr } from "@aztec/foundation/curves/bn254"
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec/stdlib/abi"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { GasSettings } from "@aztec/stdlib/gas"
import { ExecutionPayload } from "@aztec/stdlib/tx"
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet"

/**
 * Fee payment method for the FPCMultiAsset contract.
 *
 * Uses a quote-based model: the operator signs a Schnorr quote binding
 * (asset, amounts, expiry, user). The user pays via private-to-private
 * token transfer to the operator. No refund mechanism — the fee is fixed
 * at quote time.
 */
export class FPCFeePaymentMethod implements FeePaymentMethod {
  constructor(
    /** Address of the deployed FPCMultiAsset contract. */
    private paymentContract: AztecAddress,
    /** Address of the operator who receives token payment. */
    private from: AztecAddress,
    /** Token address the user pays with (e.g. USDC). */
    private acceptedAsset: AztecAddress,
    /** The user's Aztec address (msg_sender). */
    private to: AztecAddress,
    /** Wallet for creating auth witnesses. */
    private wallet: BaseWallet,
    /** Gas settings for fee computation. */
    protected gasSettings: GasSettings,

  ) {}

  async getExecutionPayload(): Promise<ExecutionPayload> {
    const nonce = Fr.random()
    const fjFeeAmount = this.gasSettings.getFeeLimit()

    // Create auth witness for the token transfer (caller = FPC contract)
    const transferSelector = await FunctionSelector.fromSignature(
      "transfer_in_private((Field),(Field),u128,Field)",
    )
    const transferCall = FunctionCall.from({
      name: "transfer_in_private",
      to: this.acceptedAsset,
      selector: transferSelector,
      type: FunctionType.PRIVATE,
      isStatic: false,
      hideMsgSender: false,
      args: [
        this.from.toField(),
        this.to.toField(),
        new Fr(fjFeeAmount),
        nonce,
      ],
      returnTypes: [],
    })

    const authWit = await this.wallet.createAuthWit(this.from, {
      caller: this.paymentContract,
      call: transferCall,
    })

    // Build fee_entrypoint call
    const feeSelector = await FunctionSelector.fromSignature(
      "fee_entrypoint((Field),(Field),(Field),u128,Field)",
    )

    const feeCall = FunctionCall.from({
      name: "fee_entrypoint",
      to: this.paymentContract,
      selector: feeSelector,
      type: FunctionType.PRIVATE,
      isStatic: false,
      hideMsgSender: false,
      args: [
        this.acceptedAsset.toField(),
        this.from.toField(),
        this.to.toField(),
        fjFeeAmount,
        nonce,
      ],
      returnTypes: [],
    })

    return new ExecutionPayload([feeCall], [authWit], [], [], this.paymentContract)
  }

  getAsset(): Promise<AztecAddress> {
    return Promise.resolve(this.acceptedAsset)
  }

  getFeePayer(): Promise<AztecAddress> {
    return Promise.resolve(this.paymentContract)
  }

  getGasSettings(): GasSettings | undefined {
    return this.gasSettings
  }
}
