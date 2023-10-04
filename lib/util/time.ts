export const currentTimestampInSeconds = () => Math.floor(Date.now() / 1000).toString();
export const currentTimestampInMs = () => Date.now().toString();
export const timestampInMstoSeconds = (timestamp: number) => Math.floor(timestamp / 1000).toString();

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
