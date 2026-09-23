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

export class OrderPostError extends CustomError {
  private static MESSAGE = 'Error posting order';

  constructor(message?: string) {
    super(message ?? OrderPostError.MESSAGE);
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, OrderPostError.prototype);
  }

  toJSON(id?: string): APIGatewayProxyResult {
    return {
      statusCode: 400,
      body: JSON.stringify({
        errorCode: ErrorCode.QuoteError,
        detail: this.message,
        id,
      }),
    };
  }
}

export class OrderDeadlineExpired extends CustomError {
  private static MESSAGE =
    'Order deadline is too close or has already expired; the order can no longer be filled. Recreate the order with a later deadline.';

  constructor(message?: string) {
    super(message ?? OrderDeadlineExpired.MESSAGE);
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, OrderDeadlineExpired.prototype);
  }

  toJSON(id?: string): APIGatewayProxyResult {
    return {
      statusCode: 400,
      body: JSON.stringify({
        errorCode: ErrorCode.ValidationError,
        detail: this.message,
        id,
      }),
    };
  }
}

export class MixedOutputTokensError extends CustomError {
  private static MESSAGE =
    'All order outputs must pay the same token. A hard quote is priced as a single tokenOut and a single summed amount, so an order whose outputs span multiple tokens cannot be quoted.';

  constructor(message?: string) {
    super(message ?? MixedOutputTokensError.MESSAGE);
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, MixedOutputTokensError.prototype);
  }

  toJSON(id?: string): APIGatewayProxyResult {
    return {
      statusCode: 400,
      body: JSON.stringify({
        errorCode: ErrorCode.ValidationError,
        detail: this.message,
        id,
      }),
    };
  }
}

export class UnknownOrderCosignerError extends CustomError {
  private static MESSAGE = 'Unknown cosigner';

  constructor() {
    super(UnknownOrderCosignerError.MESSAGE);
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, UnknownOrderCosignerError.prototype);
  }

  toJSON(id?: string): APIGatewayProxyResult {
    return {
      statusCode: 400,
      body: JSON.stringify({
        errorCode: ErrorCode.QuoteError,
        detail: this.message,
        id,
      }),
    };
  }
}
