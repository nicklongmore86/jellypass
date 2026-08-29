export class Metrics {
  readonly #counters = new Map<string, number>();
  readonly #gauges = new Map<string, number>();

  public increment(name: string, labels: Record<string, string> = {}, amount = 1): void {
    const key = metricKey(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + amount);
  }

  public gauge(name: string, value: number): void {
    this.#gauges.set(name, value);
  }

  public render(): string {
    const lines = [
      '# HELP jfa_grants Current persisted media grants.',
      '# TYPE jfa_grants gauge',
      '# HELP jfa_sync_errors Current grants whose last synchronization failed.',
      '# TYPE jfa_sync_errors gauge',
      '# HELP jfa_webhooks_total Seerr webhook events processed by result.',
      '# TYPE jfa_webhooks_total counter',
      '# HELP jfa_reconciliations_total Reconciliation attempts by result.',
      '# TYPE jfa_reconciliations_total counter',
      '# HELP jfa_item_updates_total Jellyfin item metadata updates.',
      '# TYPE jfa_item_updates_total counter',
      '# HELP jfa_policy_updates_total Jellyfin user policy updates.',
      '# TYPE jfa_policy_updates_total counter',
    ];
    for (const [key, value] of [...this.#gauges, ...this.#counters].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${key} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return name;
  const encoded = entries.map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
  return `${name}{${encoded.join(',')}}`;
}
