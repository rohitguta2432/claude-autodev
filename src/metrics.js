// Parse `claude -p --output-format json` output into { text, metrics }.
// Plain text (stubs, old CLIs) falls through with metrics: null — never breaks a run.
export function parseClaudeResult(raw) {
  try {
    const r = JSON.parse(raw);
    if (r.type !== 'result') return { text: raw, metrics: null };
    const u = r.usage ?? {};
    const models = Object.keys(r.modelUsage ?? {}).map(m => m.replace(/-\d{8}$/, ''));
    return {
      text: r.result ?? '',
      metrics: {
        tokens_in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        tokens_out: u.output_tokens ?? 0,
        cost_usd: r.total_cost_usd ?? null,
        model: models.join(' + ') || null,
        duration_ms: r.duration_ms ?? null,
      },
    };
  } catch { return { text: raw, metrics: null }; }
}
