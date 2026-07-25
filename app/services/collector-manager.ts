import { saveSignal, type SignalInput } from "./memory-engine";

export type CollectorResult = {
  collector: string;
  received: number;
  created: number;
  duplicates: number;
  failures: number;
};

export async function collectSignals(
  collector: string,
  signals: SignalInput[],
): Promise<CollectorResult> {
  let created = 0;
  let duplicates = 0;
  let failures = 0;

  for (const signal of signals) {
    try {
      const result = await saveSignal(signal);

      if (result.status === "created") {
        created++;
      } else {
        duplicates++;
      }
    } catch {
      failures++;
    }
  }

  return {
    collector,
    received: signals.length,
    created,
    duplicates,
    failures,
  };
}