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

/**
 * The encoded order is not a Dutch V2 or Dutch V3 order, the only types a hard quote cosigns: its
 * reactor maps to another order type, or to none the SDK knows. A client error, answered with a
 * 400. Same message and body as the backend uniswapx service.
 */
export class UnsupportedOrderTypeError extends CustomError {
  public static readonly MESSAGE = 'Unsupported order type. A hard quote accepts Dutch V2 and Dutch V3 orders only.';

  // The SDK's error, kept for debugging; never part of the response. (`Error`'s own `cause` option
  // needs a newer lib than this repo's ES2020.)
  public readonly cause?: unknown;

  constructor(options: { cause?: unknown } = {}) {
    super(UnsupportedOrderTypeError.MESSAGE);
    this.cause = options.cause;
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, UnsupportedOrderTypeError.prototype);
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

/**
 * The SDK could not decode the encoded order because a numeric field read out of range (ethers
 * NUMERIC_FAULT), with the decoder's error as the `cause`. Not called malformed: the SDK throws this
 * both for corrupted bytes and for some valid orders it cannot read (a Dutch V3 decay curve whose
 * packed block offsets reach 2^53, a deadline or decay time above 2^53). A client error all the
 * same, answered with a 400. The message never quotes the decoder's error, which carries the number
 * it read from the caller's bytes. Same message and body as the backend uniswapx service.
 */
export class UndecodableOrderError extends CustomError {
  public static readonly MESSAGE =
    'Undecodable order. encodedInnerOrder could not be decoded: a numeric field is out of range.';

  // The decoder's error, kept for debugging; never part of the response.
  public readonly cause?: unknown;

  constructor(options: { cause?: unknown } = {}) {
    super(UndecodableOrderError.MESSAGE);
    this.cause = options.cause;
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, UndecodableOrderError.prototype);
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

/**
 * The encoded order is not a well-formed UniswapX order: decoding it ran past the end of the bytes
 * or read an empty address (truncated, empty or non-hex input), with the decoder's error as the
 * `cause`; or it decoded but has no outputs (`NO_OUTPUTS_MESSAGE`). A client error, answered with a
 * 400. The message never quotes the decoder's error, which can echo the bytes. Same messages and
 * body as the backend uniswapx service.
 */
export class MalformedOrderError extends CustomError {
  public static readonly MESSAGE = 'Malformed order. encodedInnerOrder is not a complete ABI-encoded UniswapX order.';
  public static readonly NO_OUTPUTS_MESSAGE =
    'Malformed order. encodedInnerOrder has no outputs; an order must have at least one output.';

  // The decoder's error, kept for debugging; never part of the response.
  public readonly cause?: unknown;

  constructor(options: { cause?: unknown; message?: string } = {}) {
    super(options.message ?? MalformedOrderError.MESSAGE);
    this.cause = options.cause;
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, MalformedOrderError.prototype);
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
