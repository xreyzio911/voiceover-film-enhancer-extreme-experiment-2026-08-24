export const shouldPublishGenericFfmpegProgress = (
  activeQueueBase: string | null | undefined,
): activeQueueBase is string =>
  Boolean(activeQueueBase?.trim());

export const shouldRecycleFfmpegBeforeOperation = (
  cumulativeAudioSec: number,
  thresholdSeconds: number,
) =>
  Number.isFinite(cumulativeAudioSec) &&
  Number.isFinite(thresholdSeconds) &&
  thresholdSeconds > 0 &&
  cumulativeAudioSec >= thresholdSeconds;

export const shouldRetryFfmpegOperationAfterReset = (
  errorIsResettable: boolean,
  retriesUsed: number,
) =>
  errorIsResettable &&
  Number.isInteger(retriesUsed) &&
  retriesUsed === 0;

type FfmpegOperationWithResetRetryOptions<TWorker, TResult> = {
  worker: TWorker;
  operation: (worker: TWorker, attempt: number) => Promise<TResult>;
  shouldReset: (error: unknown) => boolean;
  reset: (worker: TWorker, error: unknown) => Promise<TWorker>;
};

export const runFfmpegOperationWithOneResetRetry = async <TWorker, TResult>({
  worker,
  operation,
  shouldReset,
  reset,
}: FfmpegOperationWithResetRetryOptions<TWorker, TResult>) => {
  try {
    return {
      result: await operation(worker, 0),
      worker,
      retried: false,
    };
  } catch (error) {
    if (!shouldRetryFfmpegOperationAfterReset(shouldReset(error), 0)) {
      throw error;
    }
    const retryWorker = await reset(worker, error);
    return {
      result: await operation(retryWorker, 1),
      worker: retryWorker,
      retried: true,
    };
  }
};
