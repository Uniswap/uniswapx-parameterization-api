export function transformQuoteRequestLogEvent(logEvent) {
  const logData = JSON.parse(logEvent.message);
  if (!logData.response) {
    throw new Error('Missing response field in log event: ' + logEvent.message);
  }
  return JSON.stringify(logData.response);
}
