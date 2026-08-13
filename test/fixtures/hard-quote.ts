// Shared V2 hard-quote order fixtures.
//
// WHY THIS FILE EXISTS: these builders were previously exported from the suites that used them
// and imported across test files. Importing a *.test.ts module runs its body inside the
// importer's jest context, so the imported file's describe/it blocks re-register in the
// importer's suite. Two consequences:
//   1. the imported suite executes twice (once on its own, once inside the importer), and
//   2. a single `it.only` in either file silences BOTH files, with no warning.
// Never import from a *.test.ts file -- put anything shared here instead.
//
// This module deliberately has no `.test.ts` suffix and is not under a `__tests__/`
// directory, so jest's default testMatch does not collect it as a suite.
//
// TIMESTAMPS: both builders read the clock at CALL time via `new Date().getTime()`, which is
// deliberately NOT `Date.now()`. test/entities/HardQuoteResponse.test.ts installs
// `jest.spyOn(Date, 'now')` at module scope; `new Date()` ignores that spy, so the order
// deadline stays a real future timestamp instead of collapsing to ~1970 and tripping the
// handler's deadline validation. Do not switch to `Date.now()`, and do not hoist the
// computation to a module-level const (module bodies of imported modules run before the
// importer's `jest.spyOn` line, so a hoisted const would silently depend on import order).

import { UnsignedV2DutchOrder, UnsignedV2DutchOrderInfo } from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers } from 'ethers';

/** UNI. Same value in every hard-quote suite. */
export const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
/** WETH. Same value in every hard-quote suite. */
export const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
/** Mainnet. `getOrder` bakes this in; `getOrderInfo` leaves the chain id to its caller. */
export const CHAIN_ID = 1;

/** Amount baked into `getOrder`. 1e18 == parseEther('1'). */
export const GET_ORDER_RAW_AMOUNT = BigNumber.from('1000000000000000000');

/**
 * Amount baked into `getOrderInfo`. 1e6, NOT 1e18 — the two builders intentionally use
 * different scales, so they cannot share one RAW_AMOUNT constant.
 */
export const GET_ORDER_INFO_RAW_AMOUNT = BigNumber.from('1000000');

/**
 * A signable, un-cosigned V2 Dutch order on mainnet. Input start == input end, so
 * HardQuoteRequest.type resolves to EXACT_INPUT unless the caller overrides `input`.
 * Default swapper/cosigner are AddressZero.
 */
export const getOrder = (data: Partial<UnsignedV2DutchOrderInfo>): UnsignedV2DutchOrder => {
  const now = Math.floor(new Date().getTime() / 1000);
  return new UnsignedV2DutchOrder(
    Object.assign(
      {
        deadline: now + 1000,
        reactor: ethers.constants.AddressZero,
        swapper: ethers.constants.AddressZero,
        nonce: BigNumber.from(10),
        additionalValidationContract: ethers.constants.AddressZero,
        additionalValidationData: '0x',
        cosigner: ethers.constants.AddressZero,
        cosignerData: undefined,
        input: {
          token: TOKEN_IN,
          startAmount: GET_ORDER_RAW_AMOUNT,
          endAmount: GET_ORDER_RAW_AMOUNT,
        },
        outputs: [
          {
            token: TOKEN_OUT,
            startAmount: GET_ORDER_RAW_AMOUNT,
            endAmount: GET_ORDER_RAW_AMOUNT.mul(90).div(100),
            recipient: ethers.constants.AddressZero,
          },
        ],
        cosignature: undefined,
      },
      data
    ),
    CHAIN_ID
  );
};

/**
 * The raw order-info struct only — the caller supplies the chain id to
 * `new UnsignedV2DutchOrder(info, chainId)`. Note the output startAmount is 2x the input,
 * unlike `getOrder`, and the amount scale is 1e6.
 */
export const getOrderInfo = (data: Partial<UnsignedV2DutchOrderInfo>): UnsignedV2DutchOrderInfo => {
  const now = Math.floor(new Date().getTime() / 1000);
  return Object.assign(
    {
      deadline: now + 1000,
      reactor: ethers.constants.AddressZero,
      swapper: ethers.constants.AddressZero,
      nonce: BigNumber.from(10),
      additionalValidationContract: ethers.constants.AddressZero,
      additionalValidationData: '0x',
      cosigner: ethers.constants.AddressZero,
      input: {
        token: TOKEN_IN,
        startAmount: GET_ORDER_INFO_RAW_AMOUNT,
        endAmount: GET_ORDER_INFO_RAW_AMOUNT,
      },
      outputs: [
        {
          token: TOKEN_OUT,
          startAmount: GET_ORDER_INFO_RAW_AMOUNT.mul(2),
          endAmount: GET_ORDER_INFO_RAW_AMOUNT.mul(90).div(100),
          recipient: ethers.constants.AddressZero,
        },
      ],
    },
    data
  );
};
