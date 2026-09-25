# Stripe PaymentIntent charge migration fixture

This is a **purpose-built, synthetic TypeScript fixture** for reviewing one Stripe
API migration. It is not customer code or a record of an actual Stripe account.
The API change and SDK declarations cited below are historical provider evidence;
the sample IDs, response objects, and scenario decisions are local test data.

## Migration contract

| Case | SDK | API version | Expected handling |
| --- | --- | --- | --- |
| `before/` target | `stripe@10.17.0` | explicitly `2022-08-01` | Read the single sample charge from `PaymentIntent.charges.data[0].id`. |
| `after/` target | `stripe@12.0.0` | explicitly `2022-11-15` | Read `PaymentIntent.latest_charge`, whether it is an ID or an expanded Charge, and retain `null` for no charge. |
| `after/src/pinned-version.ts` control | `stripe@12.0.0` | explicitly pinned to `2022-08-01` | Keep legacy response handling; the older API version is still requested. |
| `before/src/ambiguous-version.ts` control | `stripe@10.17.0` | no explicit version; account default unknown | Ask for version evidence before rewriting charge access. |

The target is an **explicit API version upgrade** alongside an SDK upgrade. The
SDK version alone does not prove the effective API version when a request has an
explicit override. The pinned and ambiguous cases are controls for that rule.
`scenarios.json` records the expected disposition of each synthetic case.

### Official before/after evidence

- Stripe's [2022-11-15 changelog](https://docs.stripe.com/changelog/2022-11-15/removes-charges-attribute-paymentintent) says `charges` was removed from `PaymentIntent` and directs integrations to `latest_charge`.
- The immutable [`stripe-node` v10.17.0 commit](https://github.com/stripe/stripe-node/tree/82fb3afd8e6c39868ca054cae99b0bd6ec1be846) declares SDK version `10.17.0` in [`package.json`](https://github.com/stripe/stripe-node/blob/82fb3afd8e6c39868ca054cae99b0bd6ec1be846/package.json#L1-L3), API type version `2022-08-01` in [`types/lib.d.ts`](https://github.com/stripe/stripe-node/blob/82fb3afd8e6c39868ca054cae99b0bd6ec1be846/types/lib.d.ts#L55), and `charges?: ApiList<Stripe.Charge>` in [`PaymentIntents.d.ts`](https://github.com/stripe/stripe-node/blob/82fb3afd8e6c39868ca054cae99b0bd6ec1be846/types/2022-08-01/PaymentIntents.d.ts#L76-L79).
- The immutable [`stripe-node` v12.0.0 commit](https://github.com/stripe/stripe-node/tree/26e730a29299c167e8c8814cda23998bb388a09d) declares SDK version `12.0.0` in [`package.json`](https://github.com/stripe/stripe-node/blob/26e730a29299c167e8c8814cda23998bb388a09d/package.json#L1-L3), API version `2022-11-15` in [`src/apiVersion.ts`](https://github.com/stripe/stripe-node/blob/26e730a29299c167e8c8814cda23998bb388a09d/src/apiVersion.ts#L1-L3), and `latest_charge?: string | Stripe.Charge | null` in [`PaymentIntents.d.ts`](https://github.com/stripe/stripe-node/blob/26e730a29299c167e8c8814cda23998bb388a09d/types/PaymentIntents.d.ts#L121-L124).
- Stripe's [Node v12 migration guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v12) explains that v12 defaults to API `2022-11-15`, while an explicit older API version remains an option. This is why the pinned control retains its old shape. The guide also explains that earlier SDK versions without an explicit API version used the account default; without that account evidence, the ambiguous control cannot be classified safely.
- The immutable [v12 TypeScript guidance](https://github.com/stripe/stripe-node/blob/26e730a29299c167e8c8814cda23998bb388a09d/README.md#L91-L102) explains why code pinned to an older API version needs a narrow type suppression.

The Git commit URLs above pin the SDK source and declarations. The dated Stripe
changelog and migration guide are canonical documentation URLs, but are not
immutable snapshots. No historical account response or customer behavior is
claimed by this fixture.

## Verify locally

Use Node.js 22.18+ and npm. The lockfiles pin both dependency sets. No Stripe
key is needed, and none of these commands sends a Stripe API request.

```sh
cd fixtures/stripe-migration
npm ci --prefix before --ignore-scripts
npm ci --prefix after --ignore-scripts

npm --prefix before run typecheck
npm --prefix before run test:baseline
npm --prefix before run test:regression  # expected exit 1: null !== 'ch_new_001'

npm --prefix after run typecheck
npm --prefix after run test:regression    # expected exit 0
npm --prefix after run test:variants      # expected exit 0
```

The regression uses only in-memory sample response objects. It first asserts
that the old function cannot read a `2022-11-15` response, then confirms the
new function reads both the string and expanded-object forms of
`latest_charge`. The baseline checks the old single-charge and empty-list
responses. The variant check confirms that the explicit old pin still reads
`charges` and that the unknown account version remains unclassified.
The tests instantiate SDK clients with a literal placeholder string and inspect
their configured version; they never call a resource method.

Stripe SDK TypeScript declarations model one API version at a time. The two
control files use localized `@ts-expect-error` comments where their intentional
runtime version differs from the SDK declaration: the v12 older-version pin,
and the v10 constructor with an unknown account default. The target files
compile against their corresponding SDK declarations without suppressions.
