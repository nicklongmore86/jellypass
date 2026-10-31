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
      '# HELP jfa_orphaned_grants Current grants whose Jellyfin item was deleted with no resolvable replacement; scheduled reconciliation skips them.',
      '# TYPE jfa_orphaned_grants gauge',
      '# HELP jfa_grant_remaps_total Grants moved to a new Jellyfin item (remapped), marked orphaned, or kept because their item reappeared (source_reappeared), by trigger (auto or admin).',
      '# TYPE jfa_grant_remaps_total counter',
      '# HELP jfa_webhooks_total Seerr webhook events processed by result.',
      '# TYPE jfa_webhooks_total counter',
      '# HELP jfa_last_webhook_received_timestamp_seconds Unix time of the last authenticated Seerr webhook call.',
      '# TYPE jfa_last_webhook_received_timestamp_seconds gauge',
      '# HELP jfa_request_backfill_total Grants created (granted) and per-request failures (error) by the Seerr request backfill.',
      '# TYPE jfa_request_backfill_total counter',
      '# HELP jfa_request_backfill_last_run_timestamp_seconds Unix time the Seerr request backfill last completed a scan.',
      '# TYPE jfa_request_backfill_last_run_timestamp_seconds gauge',
      '# HELP jfa_app_requests_total Household app API answers by endpoint (me, search, discover, movie, tv, season, get, requests, cancel, hide, unhide, hidden, unknown) and outcome (ok, app_disabled, unauthorized, rate_limited, invalid, not_found, hidden_limit, unavailable).',
      '# TYPE jfa_app_requests_total counter',
      '# HELP jfa_app_safety_markers Household app "Get this" safety tombstones that still decide a grant, by kind (request, member).',
      '# TYPE jfa_app_safety_markers gauge',
      '# HELP jfa_app_request_intents Household app "Get this" request intents not settled yet, by status (submitting, settling).',
      '# TYPE jfa_app_request_intents gauge',
      '# HELP jfa_app_deferred_webhooks Seerr webhooks deferred for a household app "Get this" request intent.',
      '# TYPE jfa_app_deferred_webhooks gauge',
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
