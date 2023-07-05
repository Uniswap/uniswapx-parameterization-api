export type DBQuoteRequest = {
  requestId: string;
  type: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  swapper: string;
  createdAt: number;
  deadline: number;
};

export type DBQuoteResponse = {
  requestId: string;
  type: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  swapper: string;
  createdAt: number;
  deadline: number;
  id: string;
  filler: string;
  amountOut: string;
};
