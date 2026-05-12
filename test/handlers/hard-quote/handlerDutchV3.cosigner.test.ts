import { TradeType } from '@uniswap/sdk-core';
import { OrderType, UnsignedV3DutchOrder, V3CosignerData } from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers } from 'ethers';

import { QuoteResponse, QuoteResponseData } from '../../../lib/entities';
import { HardQuoteRequest } from '../../../lib/entities';
import { getCosignerData } from '../../../lib/handlers/hard-quote/handler';
import { ChainId } from '../../../lib/util/chains';

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const RAW_AMOUNT = BigNumber.from('1000000000000000000');
const FILLER = '0x000000000000000000000000000000000000bEEF';

// Build a V3 order directly via the constructor so we can use chains that
// aren't in the SDK's V3 reactor mapping.
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
function buildV3Order(
  chainId: number,
  type: TradeType,
  extraOutputs: Array<{ token: string; startAmount: BigNumber; recipient: string }> = []
): UnsignedV3DutchOrder {
  const now = Math.floor(Date.now() / 1000);
  const swapperOutput = {
    token: TOKEN_OUT,
    startAmount: RAW_AMOUNT,
    curve:
      type === TradeType.EXACT_INPUT
        ? { relativeBlocks: [4], relativeAmounts: [BigInt(4)] }
        : { relativeBlocks: [], relativeAmounts: [] },
    recipient: ethers.constants.AddressZero,
    minAmount: RAW_AMOUNT.sub(4),
    adjustmentPerGweiBaseFee: BigNumber.from(0),
  };
  const feeOutputs = extraOutputs.map((extra) => ({
    token: extra.token,
    startAmount: extra.startAmount,
    curve: { relativeBlocks: [], relativeAmounts: [] },
    recipient: extra.recipient,
    minAmount: extra.startAmount,
    adjustmentPerGweiBaseFee: BigNumber.from(0),
  }));
  const info = {
    deadline: now + 1000,
    reactor: '0x000000000000000000000000000000000000B274',
    swapper: ethers.constants.AddressZero,
    nonce: BigNumber.from(100),
    additionalValidationContract: ethers.constants.AddressZero,
    additionalValidationData: '0x',
    cosigner: ethers.constants.AddressZero,
    startingBaseFee: BigNumber.from(0),
    input: {
      token: TOKEN_IN,
      startAmount: RAW_AMOUNT,
      curve:
        type === TradeType.EXACT_OUTPUT
          ? { relativeBlocks: [4], relativeAmounts: [BigInt(4)] }
          : { relativeBlocks: [], relativeAmounts: [] },
      maxAmount: RAW_AMOUNT,
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    },
    outputs: [swapperOutput, ...feeOutputs],
  } as any;
  return new UnsignedV3DutchOrder(info, chainId, PERMIT2);
}

function makeRequest(
  chainId: number,
  type: TradeType,
  extraOutputs: Array<{ token: string; startAmount: BigNumber; recipient: string }> = []
): HardQuoteRequest {
  // Stub a HardQuoteRequest for chains where the SDK has no permit2/reactor
  // entry. We bypass HardQuoteRequest.fromHardRequestBody (which would call
  // UnsignedV3DutchOrder.parse → getPermit2 → MissingConfiguration) and
  // assign order directly.
  const order = buildV3Order(chainId, type, extraOutputs);
  const req = Object.create(HardQuoteRequest.prototype) as HardQuoteRequest;
  (req as any).order = order;
  (req as any).data = {
    requestId: REQUEST_ID,
    tokenInChainId: chainId,
    tokenOutChainId: chainId,
    encodedInnerOrder: '0x',
    innerSig: '0x',
  };
  return req;
}

function makeQuote(chainId: number, type: TradeType, overrides: Partial<QuoteResponseData> = {}): QuoteResponse {
  return new QuoteResponse(
    {
      chainId,
      amountOut: RAW_AMOUNT,
      amountIn: RAW_AMOUNT,
      quoteId: QUOTE_ID,
      requestId: REQUEST_ID,
      filler: FILLER,
      swapper: ethers.constants.AddressZero,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      ...overrides,
    },
    type,
    { fillerName: 'mock', endpoint: 'mock' }
  );
}

describe('getCosignerData V3 (RFQ)', () => {
  const CURRENT_BLOCK = 1_000_000;
  const TEMPO_BASE_FEE = BigNumber.from(7);

  function makeProvider(opts: { baseFee?: BigNumber } = {}): ethers.providers.StaticJsonRpcProvider {
    return {
      getBlockNumber: jest.fn().mockResolvedValue(CURRENT_BLOCK),
      getBlock: jest.fn().mockResolvedValue({ baseFeePerGas: opts.baseFee ?? null }),
    } as unknown as ethers.providers.StaticJsonRpcProvider;
  }

  it('throws when provider missing', async () => {
    const req = makeRequest(ChainId.ARBITRUM_ONE, TradeType.EXACT_INPUT);
    const quote = makeQuote(ChainId.ARBITRUM_ONE, TradeType.EXACT_INPUT);
    await expect(getCosignerData(req, quote, OrderType.Dutch_V3, undefined)).rejects.toThrow(/rpc provider/);
  });

  it('EXACT_INPUT: better quote raises outputOverride and respects invariant outputOverride >= baseOutput', async () => {
    const req = makeRequest(ChainId.ARBITRUM_ONE, TradeType.EXACT_INPUT);
    const better = RAW_AMOUNT.add(ethers.utils.parseEther('0.1'));
    const provider = makeProvider();
    const data = (await getCosignerData(
      req,
      makeQuote(ChainId.ARBITRUM_ONE, TradeType.EXACT_INPUT, { amountOut: better }),
      OrderType.Dutch_V3,
      provider
    )) as V3CosignerData;
    expect(data.outputOverrides[0].gte(req.order.info.outputs[0].startAmount)).toBe(true);
    expect(data.exclusiveFiller.toLowerCase()).toEqual(FILLER.toLowerCase());
    expect(data.inputOverride).toEqual(BigNumber.from(0));
  });

  it('EXACT_INPUT: worse quote leaves overrides at zero', async () => {
    const req = makeRequest(ChainId.ARBITRUM_ONE, TradeType.EXACT_INPUT);
    const worse = RAW_AMOUNT.sub(1);
    const provider = makeProvider();
    const data = (await getCosignerData(
      req,
      makeQuote(ChainId.ARBITRUM_ONE, TradeType.EXACT_INPUT, { amountOut: worse }),
      OrderType.Dutch_V3,
      provider
    )) as V3CosignerData;
    expect(data.exclusiveFiller).toEqual(ethers.constants.AddressZero);
    expect(data.outputOverrides[0]).toEqual(BigNumber.from(0));
    expect(data.inputOverride).toEqual(BigNumber.from(0));
  });

  it('EXACT_OUTPUT: better quote lowers inputOverride and respects invariant inputOverride <= baseInput', async () => {
    const req = makeRequest(ChainId.MAINNET, TradeType.EXACT_OUTPUT);
    const better = RAW_AMOUNT.sub(ethers.utils.parseEther('0.1'));
    const provider = makeProvider();
    const data = (await getCosignerData(
      req,
      makeQuote(ChainId.MAINNET, TradeType.EXACT_OUTPUT, { amountIn: better }),
      OrderType.Dutch_V3,
      provider
    )) as V3CosignerData;
    expect(data.inputOverride.lte(req.order.info.input.startAmount)).toBe(true);
    expect(data.inputOverride).toEqual(better);
    expect(data.exclusiveFiller.toLowerCase()).toEqual(FILLER.toLowerCase());
  });

  it('EXACT_OUTPUT: worse quote leaves inputOverride at zero', async () => {
    const req = makeRequest(ChainId.MAINNET, TradeType.EXACT_OUTPUT);
    const worse = RAW_AMOUNT.add(1);
    const provider = makeProvider();
    const data = (await getCosignerData(
      req,
      makeQuote(ChainId.MAINNET, TradeType.EXACT_OUTPUT, { amountIn: worse }),
      OrderType.Dutch_V3,
      provider
    )) as V3CosignerData;
    expect(data.inputOverride).toEqual(BigNumber.from(0));
    expect(data.exclusiveFiller).toEqual(ethers.constants.AddressZero);
  });

  it('Mainnet: decayStartBlock buffer = ceil(2s / 12s blocks) = 1', async () => {
    const req = makeRequest(ChainId.MAINNET, TradeType.EXACT_INPUT);
    const provider = makeProvider();
    const data = (await getCosignerData(
      req,
      makeQuote(ChainId.MAINNET, TradeType.EXACT_INPUT),
      OrderType.Dutch_V3,
      provider
    )) as V3CosignerData;
    expect(data.decayStartBlock).toEqual(CURRENT_BLOCK + 1);
  });

  it('Tempo: decayStartBlock buffer = ceil(2s / 0.5s blocks) = 4', async () => {
    const req = makeRequest(ChainId.TEMPO, TradeType.EXACT_INPUT);
    const provider = makeProvider({ baseFee: TEMPO_BASE_FEE });
    const data = (await getCosignerData(
      req,
      makeQuote(ChainId.TEMPO, TradeType.EXACT_INPUT),
      OrderType.Dutch_V3,
      provider
    )) as V3CosignerData;
    expect(data.decayStartBlock).toEqual(CURRENT_BLOCK + 4);
  });

  it('Tempo: EXACT_INPUT better quote raises outputOverride and sets exclusiveFiller', async () => {
    const req = makeRequest(ChainId.TEMPO, TradeType.EXACT_INPUT);
    const better = RAW_AMOUNT.add(ethers.utils.parseEther('0.1'));
    const provider = makeProvider({ baseFee: TEMPO_BASE_FEE });
    const data = (await getCosignerData(
      req,
      makeQuote(ChainId.TEMPO, TradeType.EXACT_INPUT, { amountOut: better }),
      OrderType.Dutch_V3,
      provider
    )) as V3CosignerData;
    expect(data.outputOverrides[0].gt(BigNumber.from(0))).toBe(true);
    expect(data.outputOverrides[0].gte(req.order.info.outputs[0].startAmount)).toBe(true);
    expect(data.exclusiveFiller.toLowerCase()).toEqual(FILLER.toLowerCase());
    expect(data.inputOverride).toEqual(BigNumber.from(0));
    expect(data.decayStartBlock).toEqual(CURRENT_BLOCK + 4);
  });

  it('multi-output (swapper + fee): EXACT_INPUT increase goes entirely to outputs[0]', async () => {
    const fee = BigNumber.from('1000');
    const feeRecipient = '0x000000000000000000000000000000000000FEE5';
    const req = makeRequest(ChainId.MAINNET, TradeType.EXACT_INPUT, [
      { token: TOKEN_OUT, startAmount: fee, recipient: feeRecipient },
    ]);
    // MM quotes 100 more than the total expected output (swapper + fee).
    const totalOutputStart = RAW_AMOUNT.add(fee);
    const better = totalOutputStart.add(100);
    const provider = makeProvider();
    const data = (await getCosignerData(
      req,
      makeQuote(ChainId.MAINNET, TradeType.EXACT_INPUT, { amountOut: better }),
      OrderType.Dutch_V3,
      provider
    )) as V3CosignerData;
    // outputs[0] receives the full +100 improvement on top of its startAmount.
    expect(data.outputOverrides[0]).toEqual(RAW_AMOUNT.add(100));
    // Fee output is left at the sentinel zero — reactor will use baseOutput.
    expect(data.outputOverrides[1]).toEqual(BigNumber.from(0));
    expect(data.exclusiveFiller.toLowerCase()).toEqual(FILLER.toLowerCase());
  });
});
