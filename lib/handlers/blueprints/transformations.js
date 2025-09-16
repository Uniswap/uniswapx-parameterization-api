export function transformLogEvent(logEvent) {
  const logData = JSON.parse(logEvent.message);
  if (!logData.body) {
    throw new Error('Missing body field in log event: ' + logEvent.message);
  }
  return JSON.stringify(logData.body);
}

export function transformFillLogEvent(logEvent) {
  const logData = JSON.parse(logEvent.message);
  if (!logData.orderInfo) {
    throw new Error('Missing orderInfo field in log event: ' + logEvent.message);
  }
  return JSON.stringify(logData.orderInfo);
}

export const transformPostOrderLogEvent = transformLogEvent;
export const transformUnimindResponseLogEvent = transformLogEvent;
export const transformUnimindParameterUpdateLogEvent = transformLogEvent;
