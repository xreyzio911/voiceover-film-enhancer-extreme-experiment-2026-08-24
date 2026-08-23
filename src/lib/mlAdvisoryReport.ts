export type MlAdvisoryMetric = Readonly<{
  id: string;
  value: number | null;
  higherIsBetter: boolean;
  available: boolean;
}>;

export type MlAdvisoryReport = Readonly<{
  advisoryOnly: true;
  modelIds: readonly string[];
  metrics: readonly MlAdvisoryMetric[];
  notes: readonly string[];
  blocksDelivery: false;
  changesGainDb: false;
}>;

export const buildMlAdvisoryReport = (
  input: Readonly<{
    modelIds?: readonly string[];
    metrics?: readonly MlAdvisoryMetric[];
    notes?: readonly string[];
  }>,
): MlAdvisoryReport =>
  Object.freeze({
    advisoryOnly: true,
    modelIds: Object.freeze([...(input.modelIds ?? [])]),
    metrics: Object.freeze(
      (input.metrics ?? []).map((metric) =>
        Object.freeze({
          id: metric.id,
          value: Number.isFinite(metric.value) ? metric.value : null,
          higherIsBetter: metric.higherIsBetter,
          available: metric.available && Number.isFinite(metric.value),
        }),
      ),
    ),
    notes: Object.freeze([...(input.notes ?? [])]),
    blocksDelivery: false,
    changesGainDb: false,
  });
