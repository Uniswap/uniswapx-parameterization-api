import bodyParser from 'body-parser';
import { ethers } from 'ethers';
import express, { Request, Response } from 'express';
import { ValidationResult } from 'joi';

import { RfqRequestBody, RfqRequestBodyJoi } from './utils';

const PORT = 8080;
const HOST = '0.0.0.0';

const jsonParser = bodyParser.json();
const app = express();

app.post('/quote', jsonParser, (req: Request, res: Response) => {
  let validation: ValidationResult;
  console.log(JSON.stringify(req.body, null, 2));
  try {
    validation = RfqRequestBodyJoi.validate(req.body, {
      allowUnknown: true,
      stripUnknown: true,
    });
  } catch (e) {
    res.status(400).json(e);
    return;
  }

  if (validation.error) {
    return {
      statusCode: 400,
      detail: validation.error.details,
    };
  }
  const value = validation.value as RfqRequestBody;
  res.setHeader('Content-Type', 'application/json');

  res.status(200).json({
    chainId: value.tokenInChainId,
    requestId: value.requestId,
    tokenIn: value.tokenIn,
    tokenOut: value.tokenOut,
    amountIn: value.type === 'EXACT_INPUT' ? value.amount : '1',
    amountOut: value.type === 'EXACT_OUTPUT' ? value.amount : '1',
    offerer: value.offerer,
    filler: ethers.constants.AddressZero,
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Running on http://${HOST}:${PORT}`);
});
