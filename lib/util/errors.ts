import { APIGatewayProxyResult } from 'aws-lambda';

export enum ErrorCode {
  ValidationError = 'VALIDATION_ERROR',
  InternalError = 'INTERNAL_ERROR',
  QuoteError = 'QUOTE_ERROR',
}

export abstract class CustomError extends Error {
  abstract toJSON(id?: string): APIGatewayProxyResult;
}

export class NoQuotesAvailable extends CustomError {
  private static MESSAGE = 'No quotes available';

  constructor() {
    super(NoQuotesAvailable.MESSAGE);
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, NoQuotesAvailable.prototype);
  }

  toJSON(id?: string): APIGatewayProxyResult {
    return {
      statusCode: 404,
      body: JSON.stringify({
        errorCode: ErrorCode.QuoteError,
        detail: this.message,
        id,
      }),
    };
  }
}
