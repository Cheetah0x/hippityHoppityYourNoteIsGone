import { ContractInstanceWithAddress } from "@aztec/stdlib/contract"
import { Fr } from "@aztec/aztec.js/fields"
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract"
import { SPONSORED_FPC_SALT } from "@aztec/constants"
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC"
import { PXE } from "@aztec/pxe/client/lazy"
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee"
import { AztecAddress } from "@aztec/stdlib/aztec-address"

export async function getSponsoredFeePaymentMethod(pxe: PXE) {
  const paymentContract = await getDeployedSponsoredFPCAddress(pxe)
  return new SponsoredFeePaymentMethod(paymentContract)
}

export async function getSponsoredFPCInstance(): Promise<ContractInstanceWithAddress> {
  return await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  })
}

export async function getSponsoredFPCAddress() {
  return (await getSponsoredFPCInstance()).address
}

export async function getDeployedSponsoredFPCAddress(pxe: PXE) {
  const fpc = await getSponsoredFPCAddress()
  const contracts = await pxe.getContracts()
  if (!contracts.find((c: AztecAddress) => c.equals(fpc))) {
    throw new Error("SponsoredFPC not deployed.")
  }
  return fpc
}
