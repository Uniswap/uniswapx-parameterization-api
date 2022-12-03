export type QuoteRequest = {
  requestId: string;
  type: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  offerer: string;
  createdAt: number;
  deadline: number;
};

export type QuoteResponse = {
  requestId: string;
  type: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  offerer: string;
  createdAt: number;
  deadline: number;
  id: string;
  filler: string;
  amountOut: string;
};
