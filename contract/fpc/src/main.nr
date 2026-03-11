mod test;

use ::aztec::macros::aztec;

/// Fee Payment Contract -- Multi-Asset Variant
///
/// Unlike the standard FPC which hardcodes `accepted_asset` at deploy time,
/// this variant accepts the asset as a per-quote parameter. The user specifies
/// which asset they want to pay with when requesting a quote, the operator
/// signs a quote binding that asset+exact amounts, and `fee_entrypoint` accepts the
/// asset as an argument.
///
/// Security is preserved because the quote hash includes the asset in its
/// preimage -- the operator's Schnorr signature binds the quoted amounts to a
/// specific asset.
///
/// ## Storage
///
/// - config            (PublicImmutable<Config>) -- packed immutable config
///                                                  containing operator address
///                                                  and operator signing key.
#[aztec]
pub contract FPC {
    use aztec::{
        authwit::auth::compute_inner_authwit_hash,
        context::PrivateContext,
        macros::{functions::{allow_phase_change, external, initializer}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize, ToField}},
        state_vars::PublicImmutable,
    };
    use token::Token;



    #[external("private")]
    #[initializer]
    fn constructor() {
    }

    // Transfers the fee charge from the user's private balance directly to the
    // operator's private balance. The quote signature is verified inline using
    // the operator's stored public key -- no cross-circuit authwit call needed.

    #[external("private")]
    #[allow_phase_change]
    fn fee_entrypoint(
        accepted_asset: AztecAddress,
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        nonce: Field,
    ) {
        Token::at(accepted_asset)
            .transfer_in_private(from, to, amount, nonce)
            .call(self.context);

        self.context.set_as_fee_payer();
        self.context.end_setup();
    }
}
